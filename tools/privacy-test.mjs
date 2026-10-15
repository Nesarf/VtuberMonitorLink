// privacy-test.mjs — the live facts behind the privacy page, above all the one property that must never fail:
// **no secret may pass through it**.
//
// The page exists to answer "which endpoints is *this* install talking to", and the way such a page goes wrong is
// not that it is inaccurate - it is that it prints the very thing it is describing. A webhook URL carries its
// credential in the path, an LLM provider carries a key in the next field, and a proxy control endpoint carries a
// secret header. So the central assertion here is negative and blunt: build a configuration with a distinctive
// secret in every secret-shaped place, render the facts and the document, and assert that not one of those strings
// appears anywhere in either - with the control that the same strings *are* present in the input, so the check is
// looking at something that exists.
import assert from 'node:assert/strict';
import path from 'node:path';
import { ENDPOINT_FIELDS, describeAddress, measureDir, privacyFacts, privacyMarkdown, readPath } from '../server/src/privacy.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

/** One distinctive secret per secret-shaped field, so a leak can be traced to the field that leaked it. */
const SECRETS = {
  llmKey: 'PLACEHOLDER-llm-key-not-a-real-one',
  webhookToken: 'PLACEHOLDER-WEBHOOK-TOKEN',
  botPassword: 'PLACEHOLDER-BOT-PASSWORD',
  controlSecret: 'PLACEHOLDER-CONTROL-SECRET',
  urlPassword: 'PLACEHOLDER-URL-PASSWORD',
};

const fixture = () => ({
  llm: {
    baseUrl: 'https://api.example.com/v1',
    apiKey: SECRETS.llmKey,
    providers: [{ id: 'p1', baseUrl: 'https://api.example.com/v1', apiKey: SECRETS.llmKey, model: 'm' }],
  },
  vdb: { url: 'https://example.com/vdb.tar.gz', expectSha256: SECRETS.controlSecret },
  proxy: {
    enabled: true,
    mode: 'socks5',
    url: `socks5://user:${SECRETS.urlPassword}@127.0.0.1:10090`,
    torSocks: 'socks5://127.0.0.1:9150',
    controlUrl: 'http://127.0.0.1:9090',
    controlSecret: SECRETS.controlSecret,
  },
  watch: { targets: [{ id: 'w1', url: 'https://wiki.example.org/api.php', botPassword: SECRETS.botPassword }] },
  customSources: [{ id: 's1', url: 'https://news.example.net/feed.xml' }],
  share: { sites: [{ id: 'sh1', url: 'https://share.example.org/post' }] },
  notify: { targets: [{ id: 'n1', type: 'dingtalk', webhookUrl: `https://oapi.dingtalk.com/robot/send?access_token=${SECRETS.webhookToken}` }] },
  paths: { reportsDir: 'reports', feedsDir: 'feeds' },
});

t('the field list is data: every declared endpoint field is read from the configuration', () => {
  const cfg = fixture();
  // Each declared field is given a value one at a time, so a field that has been renamed in the config shows up
  // here as "declared but never found" rather than as a quietly missing row on the page.
  for (const field of ENDPOINT_FIELDS) {
    const one = structuredClone(cfg);
    const parts = field.path.split('.');
    let node = one;
    for (const raw of parts.slice(0, -1)) {
      const key = raw.endsWith('[]') ? raw.slice(0, -2) : raw;
      if (raw.endsWith('[]')) {
        if (!Array.isArray(node[key])) node[key] = [{}];
        node = node[key][0];
      } else {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
      }
    }
    const last = parts[parts.length - 1];
    if (parts[parts.length - 1].endsWith('[]')) node[last.slice(0, -2)] = [{ url: 'https://probe.example.com/x' }];
    else node[last] = 'https://probe.example.com/x';
    const found = privacyFacts(one).endpoints.filter((e) => e.field === field.path);
    assert.ok(found.length > 0, `${field.path} is declared but nothing was read from it`);
    assert.ok(found.some((e) => e.where.includes('probe.example.com')), `${field.path} did not carry the probe value`);
  }
  // control: a configuration with nothing configured produces no endpoints at all, so the loop above is not
  // passing because the reader invents rows.
  assert.deepEqual(privacyFacts({}).endpoints, [], 'an empty configuration must report no endpoints');
});

t('an address keeps the origin and the path, drops the query and never carries userinfo', () => {
  assert.equal(describeAddress('https://api.example.com/v1'), 'https://api.example.com/v1');
  assert.equal(describeAddress('https://api.example.com/'), 'https://api.example.com');
  assert.equal(describeAddress('https://api.example.com/v1?key=abc'), 'https://api.example.com/v1?…', 'a query is not shown, only that one exists');
  assert.equal(describeAddress('https://user:pass@api.example.com/v1'), 'https://api.example.com/v1', 'userinfo is never shown');
  assert.equal(describeAddress('https://oapi.dingtalk.com/robot/send?access_token=x', { hostOnly: true }), 'https://oapi.dingtalk.com/…');
  assert.equal(describeAddress('not a url'), 'not a url (not a parsable URL)', 'an unparseable value is reported, not hidden');
  assert.equal(describeAddress(''), '');
  // control: the credential in the userinfo is really there to be dropped
  assert.ok(/pass/.test('https://user:pass@api.example.com/v1'), 'the control fixture must contain a credential');
});

t('no secret value appears in the facts or in the document (the property this page exists to keep)', () => {
  const cfg = fixture();
  // control first: the secrets really are in the input, so a green assertion below means they were dropped rather
  // than never present.
  const raw = JSON.stringify(cfg);
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(raw.includes(value), `the control failed: ${name} is not in the fixture`);
  }
  const facts = JSON.stringify(privacyFacts(cfg));
  const doc = privacyMarkdown(privacyFacts(cfg));
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!facts.includes(value), `${name} leaked into the facts`);
    assert.ok(!doc.includes(value), `${name} leaked into the document`);
  }
  // and the *shape* of the sensitive addresses is gone too, not merely the token: the webhook keeps only its host.
  assert.ok(!/robot\/send/.test(doc), 'the webhook path is a credential and must not be printed');
  assert.ok(!/access_token/.test(doc), 'the webhook query must not be printed');
  assert.ok(doc.includes('oapi.dingtalk.com'), 'the control: the host is still shown, so the webhook was not dropped entirely');
});

t('the endpoints that are configured are the endpoints that are listed', () => {
  const cfg = fixture();
  const facts = privacyFacts(cfg);
  const wheres = facts.endpoints.map((e) => e.where);
  assert.ok(wheres.includes('https://api.example.com/v1'), 'the LLM endpoint is missing');
  assert.ok(wheres.includes('https://wiki.example.org/api.php'), 'the watched wiki is missing');
  assert.ok(wheres.includes('https://news.example.net/feed.xml'), 'the custom source is missing');
  assert.ok(wheres.includes('https://share.example.org/post'), 'the share site is missing');
  assert.ok(wheres.includes('socks5://127.0.0.1:9150'), 'the Tor SOCKS port is missing');
  // control: an endpoint that is *not* configured is not listed.
  const without = privacyFacts({ ...cfg, customSources: [] });
  assert.ok(!without.endpoints.some((e) => e.where.includes('news.example.net')), 'the control: a removed source must disappear');
});

t('the egress switches report what the configuration says, not what the policy hopes', () => {
  const on = privacyFacts(fixture());
  assert.equal(on.egress.enabled, true);
  assert.equal(on.egress.mode, 'socks5');
  assert.equal(on.egress.torSocksConfigured, true);
  assert.equal(on.anonymousMode, false);
  const off = privacyFacts({ proxy: { enabled: false, mode: 'http', torSocks: '' }, privacy: { anonymousMode: true } });
  assert.equal(off.egress.enabled, false, 'the control: a disabled proxy must read as disabled');
  assert.equal(off.egress.torSocksConfigured, false);
  assert.equal(off.anonymousMode, true);
  const docOff = privacyMarkdown(off);
  assert.ok(/proxy enabled: \*\*no\*\*/.test(docOff), 'the document must say no when the switch is off: ' + docOff.split('\n').slice(8, 12).join(' | '));
});

t('the document says whether a telemetry field exists, and the answer is derived', () => {
  const clean = privacyMarkdown(privacyFacts(fixture()));
  assert.ok(/No telemetry field exists/.test(clean), 'the sentence about telemetry is missing');
  const declared = privacyFacts({ ...fixture(), telemetry: { url: 'https://metrics.example.com' } });
  assert.equal(declared.telemetryFieldPresent, true, 'a declared telemetry field must be visible as such');
  assert.ok(/a `telemetry` field is present/.test(privacyMarkdown(declared)), 'the document must say so when one appears');
});

t('the directory measurement counts files and bytes and gives up rather than failing', () => {
  // Relative fixture paths on purpose: an absolute drive path in a published file is what the repository's own
  // sanitize check refuses, and the first version of this fixture used one (`<drive>:\data`) - correctly flagged,
  // five times. The measurement does not care where the directory is, so the fixture does not need to name one.
  const fake = (tree, { throwOn = [] } = {}) => ({
    readdirSync: (p) => {
      if (throwOn.includes(p)) throw new Error('EACCES');
      return (tree[p] ?? []).map((e) => ({ name: e.name, isDirectory: () => e.dir === true }));
    },
    statSync: (p) => ({ size: (tree[p] ?? []).length ? 10 : 10 }),
  });
  const data = 'data';
  const sub = path.join(data, 'sub');
  const tree = {
    [data]: [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'sub', dir: true }],
    [sub]: [{ name: 'c.txt' }],
  };
  const m = measureDir(data, { fs: fake(tree), maxFiles: 100 });
  assert.equal(m.files, 3, 'file count: ' + JSON.stringify(m));
  assert.equal(m.bytes, 30, 'byte count: ' + JSON.stringify(m));
  assert.equal(m.truncated, false);
  // control: the cap is real - one file allowed means a truncated result, not a silent full walk.
  const capped = measureDir(data, { fs: fake(tree), maxFiles: 1 });
  assert.equal(capped.files, 1, 'the cap must be applied: ' + JSON.stringify(capped));
  assert.equal(capped.truncated, true, 'and truncation must be reported');
  // a directory that cannot be read contributes nothing instead of throwing
  assert.equal(measureDir('unreadable', { fs: fake(tree, { throwOn: ['unreadable'] }) }), null, 'an unreadable root returns null');
  assert.equal(measureDir('', { fs: fake(tree) }), null, 'an empty path returns null');
});

t('readPath walks dotted paths and array markers and ignores non-strings', () => {
  const cfg = fixture();
  assert.deepEqual(readPath(cfg, 'proxy.controlUrl'), ['http://127.0.0.1:9090']);
  assert.deepEqual(readPath(cfg, 'watch.targets[].url'), ['https://wiki.example.org/api.php']);
  assert.deepEqual(readPath(cfg, 'llm.providers[].baseUrl'), ['https://api.example.com/v1']);
  assert.deepEqual(readPath(cfg, 'nothing.here'), [], 'a missing path yields nothing');
  assert.deepEqual(readPath(cfg, 'proxy.enabled'), [], 'a boolean is not an address');
  assert.deepEqual(readPath(cfg, 'watch'), [], 'an object is not an address');
  // control: the same walk finds a string where one exists, so the empty results above are about the values.
  assert.deepEqual(readPath({ a: 'https://x.example.com' }, 'a'), ['https://x.example.com']);
});

process.stdout.write(`\nprivacy: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);

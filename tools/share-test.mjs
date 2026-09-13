// share-test.mjs — self-test for one-click sharing
//
// The most dangerous thing in the sharing layer is not "cannot send", it is **pretending it can send
// while there is no login / no verification**, plus **turning an irreversible outbound action into
// automation**. So this self-test focuses on:
//   - a single-file HTML must have **zero external references** (the other side can open it offline / on an intranet)
//   - every target that needs a login must report honestly what is missing instead of failing silently
//   - posting must pass the confirmation gate + the state gate + the length gate, and leave an audit trail
//   - an unverified feature must not be treated as available
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHARE_TARGETS,
  appendAudit,
  buildBundle,
  bundleFilename,
  checkReadiness,
  contentDisposition,
  guardPost,
  readAudit,
  renderBundle,
  targetById,
  toHtml,
  toMarkdown,
  toPlainText,
} from '../server/src/share.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-share-'));
const cfg = { paths: { logsDir: tmp } };

const items = [
  {
    id: 'a1',
    title: '嘉然 3D披露 将于 3月15日 举行',
    text: '正文内容 <script>alert(1)</script>',
    url: 'https://example.com/a1',
    sourceId: 'official-hololive',
    publishedAt: '2026-03-01T10:00:00Z',
    people: ['jaran'],
    keywords: ['3D披露'],
  },
  { id: 'a2', title: 'Rei 新曲发布', url: 'https://example.com/a2', sourceId: 'news-ann', publishedAt: '2026-03-02T10:00:00Z', people: ['rei'] },
];
const bundle = buildBundle({
  scopeKind: 'day',
  items,
  title: 'VML 日报 2026-03-01',
  subtitle: '示例',
  note: '由 VML 生成',
  contentDate: '2026-03-01',
  generatedAt: '2026-09-12T00:00:00.000Z', // the export date is deliberately different from the content date, to prove the two are not conflated
});

process.stdout.write('\nshare: bundle contents\n');
t('bundle structure is complete', () => {
  assert.equal(bundle.items.length, 2);
  assert.ok(bundle.generatedAt);
  assert.equal(bundle.scope, 'day');
});

t('Markdown carries title / time / people / keywords / original link', () => {
  const md = toMarkdown(bundle);
  assert.ok(md.includes('# VML 日报 2026-03-01'));
  assert.ok(md.includes('嘉然 3D披露'));
  assert.ok(md.includes('👤 jaran'));
  assert.ok(md.includes('🏷 3D披露'));
  assert.ok(md.includes('https://example.com/a1'));
  assert.ok(md.includes('共 2 条'));
});

t('the plain-text version fits a chat box (title and links only)', () => {
  const txt = toPlainText(bundle);
  assert.ok(txt.includes('· 嘉然 3D披露 将于 3月15日 举行'));
  assert.ok(txt.includes('https://example.com/a1'));
  assert.ok(!txt.includes('正文内容'));
});

process.stdout.write('\nshare: single-file HTML\n');
t('the HTML has NO external references at all (it opens offline too)', () => {
  const html = toHtml(bundle);
  // http links are allowed (the original links themselves), but nothing that would load a resource
  const externalRefs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('#') && !u.startsWith('data:'));
  const loadingRefs = externalRefs.filter((u) => !/^https?:\/\/(example\.com)/.test(u));
  assert.deepEqual(loadingRefs, [], 'there must be no external resource to load: ' + loadingRefs.join(','));
  assert.ok(!/<script/i.test(html), 'a shared file should carry no script');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'it should not reference an external stylesheet');
});

t('the HTML escapes scripts inside the content (so the reader\'s browser cannot run them)', () => {
  const html = toHtml(bundle);
  assert.ok(html.includes('&lt;script&gt;'), 'it should be escaped into entities');
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

t('each of the four formats has the right mime and extension', () => {
  assert.equal(renderBundle(bundle, 'html').mime, 'text/html; charset=utf-8');
  assert.equal(renderBundle(bundle, 'md').ext, 'md');
  assert.equal(renderBundle(bundle, 'json').ext, 'json');
  assert.equal(renderBundle(bundle, 'text').ext, 'txt');
  assert.doesNotThrow(() => JSON.parse(renderBundle(bundle, 'json').body));
});

t('the filename uses the CONTENT date, not the export date (the two must not be conflated)', () => {
  const f = bundleFilename(bundle, 'html');
  assert.ok(/^vml-share-.+-2026-03-01\.html$/.test(f), f);
  assert.ok(!f.includes('2026-09-12'), 'it must not use the export date: ' + f);
  assert.ok(!/[\\/:*?"<>|]/.test(f));
});

t('it falls back to the export date only when there is no content date', () => {
  const b = buildBundle({ items: [{ id: 'x', title: 'y' }], title: 'Latest' });
  assert.ok(bundleFilename(b, 'md').endsWith('.md'));
  assert.ok(bundleFilename(b, 'md').includes(b.generatedAt.slice(0, 10)));
});

t('the content-disposition header is always pure ASCII (a Chinese name goes through RFC 5987)', () => {
  const f = bundleFilename(bundle, 'html'); // the title contains Chinese
  const header = contentDisposition(f);
  // This assertion was paid for in blood: an HTTP header with Chinese throws ERR_INVALID_CHAR outright
  // and the endpoint returns 500, while the unit test only checked "the filename is generated right",
  // so without going through the HTTP layer it is invisible
  assert.ok(/^[\x20-\x7E]+$/.test(header), 'the header must be ASCII: ' + header);
  assert.ok(header.includes("filename*=UTF-8''"), 'it must carry the UTF-8 encoded form');
  assert.ok(header.includes(encodeURIComponent(f)), 'the encoded original name must be in there');
  // The quotes are the **delimiters** of the ASCII fallback name; what is verified is that the value
  // between them contains no quote or backslash itself
  const asciiName = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
  assert.ok(asciiName.length > 0, 'there must be an ASCII fallback name');
  assert.ok(!/["\\]/.test(asciiName), 'the fallback name must contain no quote or backslash: ' + asciiName);
  assert.ok(/^[\x20-\x7E]+$/.test(asciiName));
});

t('the item count is capped (sharing should not shove a whole day of thousands of items at the other side)', () => {
  const many = buildBundle({ items: Array.from({ length: 500 }, (_, i) => ({ id: 'x' + i, title: 't' + i })) });
  assert.ok(many.items.length <= 60, 'actual ' + many.items.length);
});

process.stdout.write('\nshare: target registry and login requirements\n');
t('every target honestly declares whether a login is needed', () => {
  for (const target of SHARE_TARGETS) {
    assert.equal(typeof target.needsLogin, 'boolean', target.id);
    assert.ok(['ready', 'needs-login', 'needs-verification', 'unsupported'].includes(target.status), target.id + ' has an illegal status');
    assert.ok(target.name?.zh && target.name?.en, target.id + ' is missing a name');
    assert.ok(target.hint?.zh && target.hint?.en, target.id + ' is missing a hint');
  }
});

t('a target that needs login must declare the login kind and how it is checked', () => {
  for (const target of SHARE_TARGETS.filter((x) => x.needsLogin)) {
    assert.ok(target.loginKind, target.id + ' needs login but declares no loginKind');
  }
});

t('a target that needs no login is independent of login state and always available', () => {
  for (const target of SHARE_TARGETS.filter((x) => !x.needsLogin)) {
    assert.equal(checkReadiness(target, []).ok, true, target.id);
  }
});

t('with no login state it says honestly what is missing instead of pretending to be available', () => {
  const t1 = targetById('bilibili-dynamic');
  const r = checkReadiness(t1, []);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'needs-login');
  assert.ok(r.reason.includes('SESSDATA'), r.reason);
});

t('it can only be ready when a usable account exists (but "unverified" still does not count as ready)', () => {
  const t1 = targetById('bilibili-dynamic');
  const accounts = [{ kind: 'bilibili', name: 'someone', canSend: true }];
  const r = checkReadiness(t1, accounts);
  assert.equal(r.ok, false, 'it must not be allowed before verification');
  assert.equal(r.status, 'needs-verification');
  assert.equal(r.account, 'someone');
});

t('a platform that cannot be done is explicitly marked unsupported', () => {
  const x = targetById('x-post');
  assert.equal(x.status, 'unsupported');
  assert.equal(checkReadiness(x, [{ kind: 'twitter', canSend: true }]).status, 'unsupported');
});

process.stdout.write('\nshare: gates for outbound posting\n');
t('no explicit confirmation -> refused', () => {
  const g = guardPost(cfg, { target: 'bilibili-dynamic', text: 'hi' });
  assert.equal(g.ok, false);
  assert.ok(g.error.includes('确认'));
});

t('an unverified target -> refused (even when already logged in)', () => {
  const g = guardPost(cfg, {
    target: 'bilibili-dynamic',
    accounts: [{ kind: 'bilibili', canSend: true }],
    text: 'hi',
    confirm: true,
  });
  assert.equal(g.ok, false);
  assert.equal(g.status, 'needs-verification');
});

t('verified + logged in + confirmed -> allowed through', () => {
  const g = guardPost(cfg, {
    target: 'bilibili-dynamic',
    accounts: [{ kind: 'bilibili', canSend: true }],
    verified: ['bilibili-dynamic'],
    text: '分享内容',
    confirm: true,
  });
  assert.equal(g.ok, true);
  assert.equal(g.body, '分享内容');
});

t('unsupported platform -> refused', () => {
  const g = guardPost(cfg, { target: 'x-post', text: 'hi', confirm: true });
  assert.equal(g.ok, false);
});

t('not a posting target (for example a download) -> refused', () => {
  const g = guardPost(cfg, { target: 'file-html', text: 'hi', confirm: true });
  assert.equal(g.ok, false);
});

t('empty content and over-long content are blocked', () => {
  const base = { target: 'bilibili-dynamic', accounts: [{ kind: 'bilibili', canSend: true }], verified: ['bilibili-dynamic'], confirm: true };
  assert.equal(guardPost(cfg, { ...base, text: '   ' }).ok, false);
  assert.equal(guardPost(cfg, { ...base, text: 'x'.repeat(2001) }).ok, false);
  assert.equal(guardPost(cfg, { ...base, text: 'x'.repeat(2000) }).ok, true);
});

t('an unknown target is blocked', () => {
  assert.equal(guardPost(cfg, { target: 'nope', text: 'hi', confirm: true }).ok, false);
});

process.stdout.write('\nshare: audit\n');
t('the audit is writable, readable and append-only', () => {
  assert.equal(appendAudit(cfg, { action: 'download', target: 'file-html', items: 2 }), true);
  assert.equal(appendAudit(cfg, { action: 'post', target: 'bilibili-dynamic', ok: true }), true);
  const log = readAudit(cfg, 10);
  assert.equal(log.length, 2);
  assert.equal(log[0].action, 'post', 'the newest comes first');
  assert.ok(log[0].at);
});

t('the audit file is JSONL (one record per line, easy to append to and parse afterwards)', () => {
  const raw = fs.readFileSync(path.join(tmp, 'share.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2);
  for (const line of raw.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});

t('a missing directory does not throw (it is created instead)', () => {
  const bad = { paths: { logsDir: path.join(tmp, 'a', 'b', 'c') } };
  assert.equal(appendAudit(bad, { action: 'x' }), true, 'it should create the directory');
  assert.equal(readAudit(bad, 5).length, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

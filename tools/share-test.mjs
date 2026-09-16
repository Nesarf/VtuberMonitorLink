// ---------------------------------------------------------------------------------------------------
// What this self-test covers. The dangerous thing in the sharing layer is not "cannot send", it is
// **pretending it can send** while there is no login / no verification, plus **turning an irreversible
// outbound action into automation**. The three-stage split (account / verification / send) exists for that
// reason, so the checks are grouped the same way:
//   - a single-file HTML must have **zero external references** (the other side can open it offline / on an intranet)
//   - the image attachment is a setting, and what could not be attached is reported instead of dropped quietly
//   - the account stage, the verification stage and the send stage are three **separate** answers, and each
//     one is exercised on its own (a site that is declared but unimplemented must say so honestly)
//   - the verification stage only turns "done" from a **measurement taken for that account** (measured
//     against the site on demand), never from the presence of an account alone
//   - posting must pass the confirmation gate + all three stage gates + the length gate the site declares,
//     and leave an audit trail
//
// Every family below is also run once against a **deliberately wrong input** (see `vacuously`): a check that
// still passes on the wrong input is not checking anything, and this file refuses to call it a check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The dictionary reader is the same implementation the coverage and proofreading tools use, so "the entry
// exists" here means the same thing it means there.
import { readDicts } from './lib/i18n-source.mjs';
import {
  DEFAULT_IMAGES,
  LOGIN_KINDS,
  SHARE_SITES,
  SHARE_TARGETS,
  STAGE_I18N,
  accountsForTarget,
  appendAudit,
  applyShareSettings,
  buildBundle,
  buildHandoff,
  bundleFilename,
  contentDisposition,
  guardPost,
  imagePlan,
  pickAccountId,
  readAudit,
  recordVerification,
  renderBundle,
  renderSiteText,
  resolveSiteBody,
  sanitizeSiteEntry,
  shareTargets,
  siteProfileById,
  stageReport,
  stageStatusLabel,
  stagesReport,
  targetById,
  toHtml,
  toMarkdown,
  toPlainText,
  truncateForSite,
  verificationFreshness,
  verificationFor,
  verificationStore,
  verifiedByTarget,
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
/** The async twin of t(), for the checks that measure verification (which is an async function) */
const ta = async (name, fn) => {
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

/**
 * Control for a family of checks: a check that cannot fail is not a check.
 *
 * One family = one check function + a builder for the right input + a builder for a **deliberately wrong**
 * input. The builders are called for each side (passing values instead looked equivalent and was not: the
 * wrong value could be handed to the right side by mistake, and the control then "proved" a check that never
 * saw the difference).
 *
 * The expected shape is: the right input produces no problem, and the wrong input produces exactly one. So
 * "the check fired" is the control **succeeding** -- the first version of this helper counted a firing check
 * as a failure and therefore called every family vacuous, which is worth recording because it is the same
 * mistake in the opposite direction as a check that never fires.
 */
const VACUOUS = [];
function vacuously(family, check, buildRight, buildWrong) {
  const rightProblems = check(buildRight());
  const wrongProblems = check(buildWrong());
  const problems = [];
  for (const p of rightProblems) problems.push(`the right input was rejected: ${p}`);
  if (wrongProblems.length !== 1) {
    problems.push(
      wrongProblems.length === 0
        ? 'WRONG input passed too -- the control does not fire, so this check proves nothing'
        : `the control fired ${wrongProblems.length} times, which means it is reporting something other than the one wrong fact: ${wrongProblems.join(' / ')}`
    );
  }
  if (problems.length) {
    VACUOUS.push({ family, problems });
    fail++;
    for (const p of problems) process.stdout.write(`  [FAIL] control ${family}\n         ${p}\n`);
  } else {
    pass++;
    process.stdout.write(`  [ok]   control: "${family}" -- rejected the wrong input, accepted the right one\n`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-share-'));
const cfg = { paths: { logsDir: tmp } };
/** The shipped dictionaries, read once (the UI entries the stage mapping points at have to exist there) */
const DICTS = readDicts();

/**
 * One credential of a given login kind, shaped the way the account stage reads it.
 *
 * This used to be a single hand-written bilibili account, because one built-in site could actually be posted
 * to and it was that one. Nothing in this build enumerates credentials any more, so the fixtures are built
 * here instead: the account stage's rules (declared requirements checked against a credential, the choice of
 * account, the staleness of a measurement) are still exercised, and exercised on **supplied** credentials
 * rather than on discovered ones.
 */
function accountOf(kind, extra = {}) {
  const base = { id: 'acc-1', kind, name: `a ${kind} account` };
  if (kind === 'weibo') return { ...base, hasSession: true, hasCsrf: true, canSend: true, ...extra };
  if (kind === 'mastodon') return { ...base, hasToken: true, hasScope: true, ...extra };
  return { ...base, hasToken: true, hasScope: true, ...extra };
}

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
    images: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg', 'https://img.example.com/3.jpg'],
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
  // the image plan travels with the bundle: the recipient (and the audit) can see what was attached
  assert.ok(bundle.images && 'mode' in bundle.images && 'attached' in bundle.images, 'the bundle carries its image plan');
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

process.stdout.write('\nshare: image attachment is a setting\n');
t('with no setting the bundle attaches no image at all (and says so)', () => {
  const b = buildBundle({ items, title: 'x' });
  assert.equal(b.images.mode, 'none');
  assert.equal(b.images.attached, 0);
  assert.equal(b.items[0].images.length, 0);
  assert.ok(b.images.note.length > 0, 'a reader has to be told the images were left out');
});

t('the setting decides how many images one bundle carries (it is no longer always "up to four")', () => {
  const one = buildBundle({ items, title: 'x', images: { mode: 'source', maxPerBundle: 1 } });
  assert.equal(one.items[0].images.length, 1, 'the limit is the setting, not 4');
  const two = buildBundle({ items, title: 'x', images: { mode: 'source', maxPerBundle: 2 } });
  assert.equal(two.items[0].images.length, 2);
  assert.equal(two.images.attached, 2);
  const four = buildBundle({ items, title: 'x', images: { mode: 'source', maxPerBundle: 4 } });
  assert.equal(four.items[0].images.length, 3, 'the fixture carries three, so the setting is not the only limit');
  const none = buildBundle({ items, title: 'x', images: { mode: 'source', maxPerBundle: 0 } });
  assert.equal(none.items[0].images.length, 0);
});

t('a site\'s own image limit caps the setting (Weibo takes 9, a chat-length post takes the setting)', () => {
  const plan = imagePlan({ mode: 'source', maxPerBundle: 4 }, 9);
  assert.equal(plan.limit, 4, 'the setting is the smaller of the two');
  const wide = imagePlan({ mode: 'source', maxPerBundle: 12 }, 9);
  assert.equal(wide.limit, 9, 'the site limit wins when it is smaller');
  assert.equal(imagePlan({ mode: 'none', maxPerBundle: 9 }, 9).limit, 0, 'mode none means zero, whatever the numbers say');
  // With no site limit named the setting is the only limit. This case is where the first version of the
  // plan was wrong in a way that showed nowhere: it read "no site limit" as "the site allows nothing"
  // (Number(null) is 0, and 0 is finite), so a bundle that asked for images got none.
  assert.equal(imagePlan({ mode: 'source', maxPerBundle: 1 }, null).limit, 1, 'a missing site limit must not mean zero');
  assert.equal(imagePlan({ mode: 'source', maxPerBundle: 4 }).limit, 4, 'the same, with the argument left out');
  assert.equal(imagePlan({ mode: 'source', maxPerBundle: 4 }, '').limit, 4, 'and with an empty string');
});

t('an inline bundle embeds a data: URI and reports what it could not embed', () => {
  const tiny = 'data:image/png;base64,iVBORw0KGgo=';
  const b = buildBundle({
    items: [{ id: 'i', title: 't', images: [tiny, 'https://img.example.com/remote.jpg'] }],
    title: 'x',
    images: { mode: 'inline', maxPerBundle: 4, inlineMaxBytes: 100000 },
  });
  assert.deepEqual(b.items[0].images, [tiny]);
  assert.equal(b.images.skipped, 1, 'a remote image cannot be inlined by a synchronous renderer, so it must be counted');
  assert.ok(b.images.note.includes('1'), 'the note has to name the number left out: ' + b.images.note);
  const html = toHtml(b);
  assert.ok(html.includes('src="data:image/png;base64,'), 'the inlined image is really rendered');
  assert.ok(!html.includes('img.example.com'), 'and the remote one is not referenced');
});

t('an oversized data: URI is left out rather than bloating the bundle', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(500);
  const b = buildBundle({
    items: [{ id: 'i', title: 't', images: [big] }],
    title: 'x',
    images: { mode: 'inline', maxPerBundle: 4, inlineMaxBytes: 100 },
  });
  assert.equal(b.items[0].images.length, 0);
  assert.equal(b.images.skipped, 1);
});

t('the default image setting is "none" (a remote image is the one thing that can make a shared file look broken)', () => {
  assert.equal(DEFAULT_IMAGES.mode, 'none');
});

process.stdout.write('\nshare: target registry and login requirements\n');
t('every target honestly declares whether a login is needed', () => {
  for (const target of SHARE_TARGETS) {
    assert.equal(typeof target.needsLogin, 'boolean', target.id);
    assert.ok(['ready', 'needs-login', 'needs-verification', 'unsupported', 'unimplemented'].includes(target.status), target.id + ' has an illegal status');
    assert.ok(target.name?.zh && target.name?.en, target.id + ' is missing a name');
    assert.ok(target.hint?.zh && target.hint?.en, target.id + ' is missing a hint');
  }
});

t('a posting site is in exactly one of two situations: planned, or not allowed at all', () => {
  for (const site of SHARE_SITES) {
    assert.equal(typeof site.implemented, 'boolean', site.id);
    assert.equal(typeof site.unsupported, 'boolean', site.id);
    // the two may not both be true: "we wrote it" and "it must never be done" cannot hold at once
    assert.ok(!(site.implemented && site.unsupported), site.id + ' is both implemented and unsupported');
  }
  // No built-in site has publish code any more: the only implementation this project had was the one site
  // that was removed with its platform. That is a fact worth pinning — "there is no publish code" and "the
  // code was deleted by accident" look identical on the page, and only one of them is intended.
  const implemented = SHARE_SITES.filter((s) => s.implemented).map((s) => s.id);
  assert.deepEqual(implemented, [], 'no built-in site may claim publish code: ' + implemented.join(', '));
  const mastodon = targetById('mastodon-post');
  assert.equal(mastodon.status, 'unimplemented', 'a site that is merely unfinished must not be called unsupported');
});

t('a target that needs login must declare the login kind and how it is checked', () => {
  for (const target of SHARE_TARGETS.filter((x) => x.needsLogin)) {
    assert.ok(target.loginKind, target.id + ' needs login but declares no loginKind');
  }
});

t('the retired platforms are not offered as login kinds any more', () => {
  const kinds = LOGIN_KINDS.map((k) => k.id);
  assert.ok(!kinds.includes('bilibili'), 'a bilibili login kind came back');
  assert.ok(!kinds.includes('twitter'), 'an X/Twitter login kind came back');
  // The control: the kinds that remain are still there, so "the list is empty" cannot satisfy the check.
  assert.deepEqual(kinds.filter(Boolean).sort(), ['mastodon', 'reddit', 'weibo', 'youtube']);
  assert.ok(kinds.includes(null), 'the "no login" option must stay in the list');
});

t('a target that needs no login is independent of login state and always available', () => {
  for (const target of SHARE_TARGETS.filter((x) => !x.needsLogin)) {
    const r = stageReport(target, [], {});
    assert.equal(r.send.status, 'ready', target.id);
    assert.equal(r.send.actionable, true, target.id);
  }
});

t('with no credential the account stage is the one that is missing, and it names what the site needs', () => {
  const r = stageReport(targetById('mastodon-post'), [], {});
  assert.equal(r.account.status, 'missing');
  assert.equal(r.send.status, 'unimplemented', 'no publish code, so the send stage says that');
});

process.stdout.write('\nshare: the three separate stages (account / verification / send)\n');
t('every posting site is represented, and every one of them declares no publish code', () => {
  const posts = SHARE_TARGETS.filter((x) => x.kind === 'post').map((x) => x.id);
  // Four built-in posting sites. The two that were removed with their platforms are not in the list, and the
  // count is pinned rather than lower-bounded: a fifth entry coming back through a helper nobody meant to
  // keep is exactly what this number is here to notice.
  assert.deepEqual(posts, ['weibo-post', 'youtube-community', 'mastodon-post', 'reddit-post']);
  for (const id of posts) assert.ok(siteProfileById(id), id + ' has no per-site profile');
  assert.equal(SHARE_SITES.length, posts.length, 'one profile per posting site');
});

t('a site declares what it needs before sharing (login kind + credential + named requirements)', () => {
  for (const site of SHARE_SITES) {
    assert.ok(site.loginKind, site.id + ' declares no loginKind');
    assert.ok(site.credential?.zh && site.credential?.en, site.id + ' does not say what the credential is');
    assert.ok(Array.isArray(site.requirements) && site.requirements.length, site.id + ' declares no requirements');
    assert.ok(Number.isFinite(site.textLimit) && site.textLimit > 0, site.id + ' declares no text limit');
    assert.ok(Number.isFinite(site.maxImages) && site.maxImages >= 0, site.id + ' declares no image limit');
  }
  // Every login kind offered is one of the kinds a hand-added site may declare, and no retired platform is
  // among them (a profile that declares a kind the module rejects would be a built-in the module refuses).
  const kinds = new Set(LOGIN_KINDS.map((k) => k.id));
  for (const site of SHARE_SITES) assert.ok(kinds.has(site.loginKind), `${site.id} declares the unknown kind ${site.loginKind}`);
});

t('the three stages are three independent answers, each with an id of its own', () => {
  const accounts = [{ id: 'acc-1', kind: 'weibo', name: 'someone', hasSession: true, hasCsrf: true, canSend: true }];
  const r = stageReport(targetById('weibo-post'), accounts, {});
  assert.deepEqual(Object.keys(r).slice(0, 3).sort(), ['account', 'send', 'verification']);
  assert.equal(r.account.id, 'account');
  assert.equal(r.verification.id, 'verification');
  assert.equal(r.send.id, 'send');
  assert.equal(r.account.status, 'satisfied');
  assert.equal(r.verification.status, 'needed', 'having an account does not verify anything');
  assert.equal(r.send.status, 'unimplemented');
});

t('with no account the account stage is the one that is missing (and it names the credential)', () => {
  const r = stageReport(targetById('weibo-post'), [], {});
  assert.equal(r.account.status, 'missing');
  assert.ok(r.account.credential.zh.includes('cookie'), r.account.credential.zh);
  assert.equal(r.verification.status, 'needed');
  assert.equal(r.send.status, 'unimplemented');
});

t('a credential that is short of one declared requirement is reported as unsatisfied (not as "logged in")', () => {
  const accounts = [{ id: 'acc-1', kind: 'weibo', name: 'someone', hasSession: true, hasCsrf: false, canSend: false }];
  const r = stageReport(targetById('weibo-post'), accounts, {});
  assert.equal(r.account.status, 'missing');
  assert.deepEqual(r.account.unsatisfied.map((u) => u.id), ['csrf']);
  assert.equal(r.send.status, 'unimplemented');
});

t('a site whose publish code does not exist says "not implemented" instead of offering a button', () => {
  const accounts = [{ id: 'acc-1', kind: 'weibo', name: 'someone', hasSession: true, hasCsrf: true, canSend: true }];
  for (const id of ['weibo-post', 'youtube-community', 'mastodon-post', 'reddit-post']) {
    const stage = stagesReport(accounts, {}, {}).find((x) => x.id === id);
    assert.equal(stage.stages.send.status, 'unimplemented', id);
    assert.equal(stage.stages.send.actionable, false, id + ' must not be actionable');
    assert.ok(stage.stages.send.detail.zh.includes('还没实现'), id + ': ' + stage.stages.send.detail.zh);
  }
});

// The login stage is independent of the send stage: a site whose publishing has no code (which is every site
// in this build) still offers a real login check, because "am I signed in there?" is measurable on its own and
// a hand-off is exactly the moment somebody wants to know. The measurement that remains is the read-only
// cookie probe against the site's own host, and the stage has to say so -- while `verified` is never claimed
// without a measurement that actually ran.
t('a site with no site-specific measurement reports the cookie probe as the one that can run', () => {
  const accounts = [{ id: 'acc-1', kind: 'weibo', name: 'someone', hasSession: true, hasCsrf: true, canSend: true }];
  const r = stageReport(targetById('weibo-post'), accounts, {});
  assert.equal(r.verification.status, 'needed', 'it is measurable, not blocked');
  assert.equal(r.verification.probe, 'cookie-probe', 'and it says which measurement it would use');
  assert.equal(r.verification.fallbackProbe, 'cookie-probe');
  assert.equal(r.verification.actionable, true, 'the login state can be checked on this site');
  assert.equal(r.verification.accountId, 'acc-1');
  assert.equal(r.send.status, 'unimplemented', 'posting to it still has no code');
  assert.equal(r.send.actionable, false, 'and a login state on its own does not make it postable');
});

t('a site that declares a measurement of its own is named, and is not claimed runnable without a credential', () => {
  // A declared profile, because no built-in site carries a probe of its own any more: the two that did were
  // removed with the sites they belonged to, and both needed a credential this build does not look up.
  const cfg = { share: { sites: [{ id: 'probe-site', loginKind: 'mastodon', verify: 'token-scope', manual: { compose: 'https://{instance}/publish?text={text}' } }] } };
  const r = stageReport(targetById('probe-site', cfg), [{ id: 'm', kind: 'mastodon', hasToken: true, hasScope: true }], {}, { cfg });
  assert.equal(r.verification.probe, 'token-scope', 'the site names its own measurement');
  assert.equal(r.verification.actionable, false, 'running it would need a credential nothing here looks up');
  assert.equal(r.verification.fallbackProbe, null, 'and there is no host to fall back to either');
});

t('a login kind with no probe and no host is the one case that has nothing to run, and it says so', () => {
  // A cookie login kind (so no probe of its own) on a site whose host is a placeholder nobody owns.
  const cfg = { share: { sites: [{ id: 'weibo-no-host', loginKind: 'weibo', manual: { compose: 'https://{instance}/compose?text={text}' } }] } };
  const r = stageReport(targetById('weibo-no-host', cfg), [{ id: 'a', kind: 'weibo', canSend: true }], {}, { cfg });
  assert.equal(r.verification.status, 'blocked');
  assert.equal(r.verification.actionable, false, 'nothing can be read for a domain that is not known');
  assert.equal(r.verification.probe, null);
});

t('the file/export targets need no login and no verification; their send stage is simply available', () => {
  for (const id of ['file-html', 'file-md', 'file-json', 'text', 'webhook']) {
    const r = stageReport(targetById(id), [], {});
    assert.equal(r.account.status, 'not-required', id);
    assert.equal(r.verification.status, 'not-required', id);
    assert.equal(r.send.status, 'ready', id);
    assert.equal(r.send.actionable, true, id);
  }
});

t('the API contract of the target list holds for every target (the page reads these fields directly)', () => {
  const accounts = [
    { id: 'acc-1', kind: 'mastodon', name: 'm', hasToken: true, hasScope: true },
    { id: 'acc-2', kind: 'weibo', name: 'w', hasSession: true, hasCsrf: true, canSend: true },
  ];
  const list = stagesReport(accounts, {}, {});
  assert.equal(list.length, 9, 'the five file targets plus the four sites: ' + list.map((x) => x.id).join(', '));
  for (const x of list) {
    assert.ok(x.id && x.name?.zh && x.name?.en, x.id + ' has no name');
    assert.equal(typeof x.declaredStatus, 'string', x.id + ' does not say what it declares');
    for (const key of ['account', 'verification', 'send']) {
      const s = x.stages?.[key];
      assert.ok(s, `${x.id} has no ${key} stage`);
      assert.equal(s.id, key, `${x.id}: the ${key} stage does not identify itself`);
      assert.equal(typeof s.status, 'string', `${x.id}/${key} has no status`);
      assert.ok(s.i18nKey, `${x.id}/${key} has no dictionary entry`);
      assert.ok(s.detail?.zh && s.detail?.en, `${x.id}/${key} has no bilingual detail`);
      assert.equal(typeof s.actionable, 'boolean', `${x.id}/${key} does not say whether it can be acted on`);
    }
    assert.equal(typeof x.stages.send.implemented, 'boolean', x.id + ' does not say whether sending exists');
    if (x.kind === 'post') {
      // A posting target must also say what the site needs and whether the account/verify steps can be acted on
      assert.ok(x.site?.credential?.zh && x.site?.credential?.en, x.id + ' does not say what the credential is');
      assert.ok(Array.isArray(x.site.requirements) && x.site.requirements.length, x.id + ' declares no requirements');
    } else {
      assert.equal(x.needsLogin, false, x.id + ' is a file target that claims to need a login');
      assert.equal(x.stages.send.actionable, true, x.id + ' should always be available');
    }
  }
});

t('every stage state maps to a UI entry that exists in the dictionary (not merely to a key-shaped string)', () => {
  // The module hands the web view the name of a dictionary entry; if that entry does not exist the UI shows
  // the key itself ("shareNeedsVerify" as a label) and nothing anywhere raises an error. So the names are read
  // back out of web/src/i18n.jsx here. This check deliberately lives in this test rather than in the UI: the
  // mapping is data this module owns.
  const { zh, en } = DICTS;
  const seen = new Set();
  for (const [stage, states] of Object.entries(STAGE_I18N)) {
    for (const [state, key] of Object.entries(states)) {
      assert.ok(key, `${stage}/${state} maps to nothing`);
      assert.ok(zh.has(key), `${stage}/${state} maps to "${key}", which is not in the zh dictionary`);
      assert.ok(en.has(key), `${stage}/${state} maps to "${key}", which is not in the en dictionary`);
      seen.add(key);
    }
  }
  assert.ok(seen.size >= 5, 'the mapping really points at several entries: ' + [...seen].join(', '));
});

t('the plain label of a stage state is bilingual data, and it exists for every state the module can emit', () => {
  const states = {
    account: ['satisfied', 'missing', 'unknown', 'not-required'],
    verification: ['done', 'needed', 'blocked', 'not-required', 'unknown'],
    send: ['ready', 'blocked', 'unimplemented', 'unknown'],
  };
  for (const [stage, list] of Object.entries(states)) {
    for (const s of list) {
      const label = stageStatusLabel(stage, s);
      assert.ok(label.key, `${stage}/${s} has no UI entry`);
      assert.ok(label.label.en && label.label.zh, `${stage}/${s} has no plain label`);
    }
  }
});

t('the stage mappings are a table, not a function of the target (so a new site cannot silently get a wrong label)', () => {
  // Every state the module can emit has to appear in the table for its stage; a missing row would make the
  // web view fall back to the raw status string, which is exactly the untranslated string this repo forbids.
  const states = {
    account: ['satisfied', 'missing', 'unknown', 'not-required'],
    verification: ['done', 'needed', 'blocked', 'not-required', 'unknown'],
    send: ['ready', 'blocked', 'unimplemented', 'unknown'],
  };
  for (const [stage, list] of Object.entries(states)) {
    for (const s of list) {
      const label = stageStatusLabel(stage, s);
      assert.ok(label.key, `${stage}/${s} has no UI entry`);
      assert.ok(label.label.en && label.label.zh, `${stage}/${s} has no plain label`);
    }
  }
});

t('the verification store reads the old list-of-ids shape instead of dropping it (a working setup must not silently re-block)', () => {
  const legacy = verificationStore({ share: { verifiedTargets: ['weibo-post'] } });
  assert.equal(legacy['weibo-post']['*'].legacy, true);
  const accounts = [accountOf('weibo')];
  const r = stageReport(targetById('weibo-post'), accounts, legacy);
  // A legacy entry claims "this code path once worked", not "this account can post" -- it carries no account
  // and no date, and an undated claim cannot be treated as a fresh measurement. So it does not open the send
  // gate, and it is presented as something that has to be measured again.
  assert.equal(r.verification.status, 'needed');
  assert.equal(r.verification.lastOk, true, 'the old pass is still reported as the last known result');
  assert.ok(r.verification.detail.en.includes('stale'), JSON.stringify(r.verification.detail));
  const f = verificationFreshness(legacy['weibo-post']['*']);
  assert.equal(f.verifiedAt, null);
  assert.equal(f.ageMs, null);
  assert.equal(f.stale, true, 'an undated entry is presented as stale rather than as fresh');
  // A declared site is reached through its profile, and a target nobody declares has no profile at all --
  // which is the shape the fixtures have to go through now that no built-in site carries one of its own.
  const declared = { share: { sites: [{ id: 'declared', loginKind: 'weibo', host: 'weibo.com' }] } };
  assert.equal(siteProfileById('declared', declared)?.loginKind, 'weibo');
  assert.equal(siteProfileById('declared', {}), null);
});

t('a verification result older than the TTL is presented as stale rather than as done', () => {
  const old = { at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), ok: true };
  const f = verificationFreshness(old);
  assert.equal(f.stale, true);
  const accounts = [accountOf('weibo')];
  const store = recordVerification({}, 'weibo-post', 'acc-1', old);
  const r = stageReport(targetById('weibo-post'), accounts, store);
  assert.equal(r.verification.status, 'needed');
  assert.equal(r.verification.lastOk, true, 'the old pass is still reported, marked as the last one');
  assert.equal(r.verification.verifiedAt, old.at, 'and the date it was measured at travels with it');
  assert.ok(r.verification.detail.en.includes('stale') || r.verification.detail.zh.includes('过期'), JSON.stringify(r.verification.detail));
});

process.stdout.write('\nshare: adding a site of your own (declared profile + measurement)\n');
const customCfg = {
  share: {
    sites: [
      {
        id: 'my-site',
        name: { zh: '发到我的站点', en: 'Post to my site' },
        loginKind: 'weibo',
        credential: { zh: '复用微博登录态', en: 'reuses the Weibo login' },
        requirements: ['login', 'session', 'csrf'],
        implemented: false,
        textLimit: 500,
        maxImages: 2,
      },
    ],
  },
};

/**
 * A declared site with a **concrete** compose page and a 280-character limit.
 *
 * The hand-off's compose-link rules cannot be exercised on the built-in sites any more: the one built-in
 * template with a `{text}` placeholder is Mastodon's, whose host is `{instance}` (the user's own), so no link
 * can be built from it -- a fact two checks below assert rather than paper over. A declared site has a real
 * host and a real limit, which is exactly what those rules need.
 */
const composeSiteCfg = {
  share: {
    sites: [
      {
        id: 'my-compose',
        name: { zh: '发到我的实例', en: 'Post to my instance' },
        loginKind: 'mastodon',
        host: 'example.social',
        manual: { compose: 'https://example.social/publish?text={text}' },
        textLimit: 280,
        maxImages: 4,
      },
    ],
  },
};

t('a config-declared site appears in the target list with its own profile', () => {
  const ids = shareTargets(customCfg).map((x) => x.id);
  assert.ok(ids.includes('my-site'), 'the custom site is listed: ' + ids.join(', '));
  const p = siteProfileById('my-site', customCfg);
  assert.equal(p.loginKind, 'weibo');
  assert.equal(p.textLimit, 500);
  assert.equal(p.maxImages, 2);
  assert.equal(p.implemented, false);
  assert.equal(p.custom, true);
  assert.equal(targetById('my-site', customCfg).custom, true);
  // and it must not exist when the config does not declare it
  assert.equal(targetById('my-site', {}), null);
});

t('a declared custom site is measured against the credentials it is given (its requirements are checked, not guessed)', () => {
  const accounts = [accountOf('weibo')];
  const stage = stagesReport(accounts, {}, customCfg).find((x) => x.id === 'my-site');
  assert.equal(stage.stages.account.status, 'satisfied');
  assert.equal(stage.stages.send.status, 'unimplemented');
  const short = [accountOf('weibo', { hasCsrf: false, canSend: false })];
  const stage2 = stagesReport(short, {}, customCfg).find((x) => x.id === 'my-site');
  assert.equal(stage2.stages.account.status, 'missing');
  assert.deepEqual(stage2.stages.account.unsatisfied.map((u) => u.id), ['csrf']);
});

t('a site cannot be added twice, and a site with no login kind does not claim to need one', () => {
  const dup = shareTargets({ share: { sites: [{ id: 'weibo-post' }, { id: 'no-login-site', loginKind: null }] } });
  assert.equal(dup.filter((x) => x.id === 'weibo-post').length, 1, 'a declared id may not shadow a built-in');
  assert.equal(dup.find((x) => x.id === 'no-login-site').needsLogin, false);
});

t('a custom site with no publish code cannot be posted to, whatever the config asks for', () => {
  const accounts = [accountOf('weibo')];
  const store = recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true });
  const g = guardPost(customCfg, { target: 'my-site', accounts, verified: store, text: 'hi', confirm: true });
  assert.equal(g.ok, false);
  assert.equal(g.status, 'unimplemented');
});

process.stdout.write('\nshare: the verification stage is data the app owns (no probe can run in this build)\n');
// The two site-specific probes this project implemented belonged to the two sites that were removed, and both
// needed a credential that nothing here enumerates. What is left is not "no verification" but "the stage
// still reports, per account and per measurement, what is known": these checks pin that it keeps doing so,
// and that it never invents a pass.
await ta('a stored pass for the chosen account turns the stage done, and the send stage still says there is no code', async () => {
  const account = accountOf('weibo');
  const store = recordVerification({}, 'weibo-post', account.id, { at: new Date().toISOString(), ok: true, method: 'a measurement', detail: { zh: '通过', en: 'pass' } });
  const stage = stageReport(targetById('weibo-post'), [account], store);
  assert.equal(stage.verification.status, 'done');
  assert.equal(stage.verification.accountId, account.id);
  assert.equal(stage.verification.actionable, false, 'the send-stage measurement cannot be run in this build, and says so');
  assert.equal(stage.send.status, 'unimplemented', 'a verified login does not create publish code');
  assert.equal(stage.send.actionable, false);
});

await ta('a stored failure leaves the stage needing attention, with the reason the measurement gave', async () => {
  const account = accountOf('weibo');
  const store = recordVerification({}, 'weibo-post', account.id, { at: new Date().toISOString(), ok: false, reason: 'the site refused the credential', detail: { zh: '被拒绝', en: 'refused' } });
  const stage = stageReport(targetById('weibo-post'), [account], store);
  assert.equal(stage.verification.status, 'needed');
  assert.equal(stage.verification.lastOk, false);
  assert.ok(stage.verification.detail.en.includes('refused'), JSON.stringify(stage.verification.detail));
});

await ta('a pass measured for one account says nothing about another account', async () => {
  const mine = accountOf('weibo', { id: 'acc-1', name: 'mine' });
  const theirs = accountOf('weibo', { id: 'acc-2', name: 'theirs' });
  const store = recordVerification({}, 'weibo-post', 'acc-1', { at: new Date().toISOString(), ok: true });
  assert.equal(stageReport(targetById('weibo-post'), [mine], store).verification.status, 'done');
  assert.equal(stageReport(targetById('weibo-post'), [theirs], store).verification.status, 'needed');
  // and the stored result is looked up by (target, account), which is the whole reason the store is keyed
  // that way rather than by target alone
  assert.ok(verificationFor(store, 'weibo-post', 'acc-1'));
  assert.equal(verificationFor(store, 'weibo-post', 'acc-2'), null);
});

await ta('nothing here claims a pass it did not measure: a site with no account and no fallback is "not measured"', async () => {
  const stage = stageReport(targetById('mastodon-post'), [], {});
  assert.equal(stage.verification.status, 'needed');
  assert.equal(stage.verification.actionable, false, 'a hostless site has no cookie probe to fall back to');
  assert.equal(stage.verification.probe, 'token-scope', 'the site names the measurement it declares');
  assert.equal(stage.verification.fallbackProbe, null, 'and there is nothing this build could run instead');
  assert.equal(typeof stage.verification.notRunnable?.zh, 'string', 'and it carries the reason in words');
  assert.equal(typeof stage.verification.notRunnable?.en, 'string');
});

await ta('every stage that cannot be acted on carries a reason, and every one that can carries none', async () => {
  // The rule this pins is the one from an earlier round: a disabled control must say why. `actionable:
  // false` with nothing to read is exactly the dead cell that rule forbids, so the two fields are asserted
  // together -- on every built-in target, and on a declared profile whose own probe cannot run here.
  const declared = { share: { sites: [{ id: 'probe-site', loginKind: 'mastodon', verify: 'token-scope', host: 'example.social' }] } };
  for (const x of [...stagesReport([], {}, {}), ...stagesReport([], {}, declared).filter((y) => y.custom)]) {
    const v = x.stages.verification;
    // File/export targets are a third case: their verification stage is `not-required`, which is a complete
    // answer in itself and needs no reason. The rule is about a stage that describes work that cannot be done.
    if (v.status === 'not-required') continue;
    if (v.actionable) assert.equal(v.notRunnable ?? null, null, `${x.id} can be run, so it must not carry a "cannot run" reason`);
    else assert.ok(v.notRunnable?.zh && v.notRunnable?.en, `${x.id} cannot be acted on and explains nothing`);
  }
});


process.stdout.write('\nshare: gates for outbound posting\n');
// No built-in site has publish code any more, so `guardPost` stops every one of them at "not implemented"
// before it can look at a login. That is the honest answer of this build, and it is asserted below -- but the
// login and verification gates behind it are the discipline a future implementation has to pass through, so
// they are exercised on a **declared** site that claims publish code. The config is hand-written here on
// purpose: it is the only shape that reaches those gates at all in this build.
const implementedSiteCfg = { share: { sites: [{ ...customCfg.share.sites[0], implemented: true }] } };

t('no explicit confirmation -> refused', () => {
  const g = guardPost(implementedSiteCfg, { target: 'my-site', text: 'hi' });
  assert.equal(g.ok, false);
  assert.ok(g.error.includes('确认'));
});

t('an unverified account -> refused (even when the credential is complete)', () => {
  const g = guardPost(implementedSiteCfg, {
    target: 'my-site',
    accounts: [accountOf('weibo')],
    text: 'hi',
    confirm: true,
  });
  assert.equal(g.ok, false);
  assert.equal(g.status, 'needs-verification');
});

t('no account at all -> refused with the account stage as the reason', () => {
  const g = guardPost(implementedSiteCfg, { target: 'my-site', accounts: [], text: 'hi', confirm: true });
  assert.equal(g.ok, false);
  assert.equal(g.status, 'needs-login');
  assert.ok(g.error.includes('微博'), 'the refusal names the login kind it is missing: ' + g.error);
});

t('logged in + verified + confirmed -> allowed through', () => {
  const g = guardPost(implementedSiteCfg, {
    target: 'my-site',
    accounts: [accountOf('weibo')],
    verified: recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true }),
    text: '分享内容',
    confirm: true,
  });
  assert.equal(g.ok, true);
  assert.equal(g.body, '分享内容');
  assert.equal(g.accountId, 'acc-1', 'the gate reports the account it cleared');
});

t('verified for a different account -> still refused', () => {
  const g = guardPost(implementedSiteCfg, {
    target: 'my-site',
    accounts: [accountOf('weibo', { id: 'acc-9' })],
    verified: recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true }),
    text: 'hi',
    confirm: true,
  });
  assert.equal(g.ok, false);
  assert.equal(g.status, 'needs-verification');
});

t('every built-in site is refused as "no publish code", which is what this build ships', () => {
  // The other half of the same fact: without a hand-written `implemented: true` the gate never reaches the
  // login stage at all, so a caller cannot read "this site has no publish code" as "your login is the problem".
  for (const id of ['weibo-post', 'youtube-community', 'mastodon-post', 'reddit-post']) {
    const g = guardPost(cfg, { target: id, accounts: [accountOf('weibo')], text: 'hi', confirm: true });
    assert.equal(g.ok, false, id);
    assert.equal(g.status, 'unimplemented', id);
    assert.ok(g.error.includes('还没实现'), id + ': ' + g.error);
  }
});

t('not a posting target (for example a download) -> refused', () => {
  const g = guardPost(cfg, { target: 'file-html', text: 'hi', confirm: true });
  assert.equal(g.ok, false);
});

t('empty content and over-long content are blocked', () => {
  const base = {
    target: 'my-site',
    accounts: [accountOf('weibo')],
    verified: recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true }),
    confirm: true,
  };
  // my-site declares 500 characters, so these two bounds are the site's own numbers rather than a constant
  assert.equal(guardPost(implementedSiteCfg, { ...base, text: '   ' }).ok, false);
  assert.equal(guardPost(implementedSiteCfg, { ...base, text: 'x'.repeat(501) }).ok, false);
  assert.equal(guardPost(implementedSiteCfg, { ...base, text: 'x'.repeat(500) }).ok, true);
});

t('the length gate uses the limit the site itself declares, not a hard-coded 2000', () => {
  const accounts = [accountOf('weibo')];
  const store = recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true });
  // my-site declares 500 characters, so this text is over its limit even though the other sites would take it
  const custom = { share: { sites: [{ ...customCfg.share.sites[0], implemented: true }] } };
  const g = guardPost(custom, { target: 'my-site', accounts, verified: store, text: 'x'.repeat(600), confirm: true });
  assert.equal(g.ok, false);
  assert.ok(g.error.includes('500'), g.error);
  assert.equal(guardPost(custom, { target: 'my-site', accounts, verified: store, text: 'x'.repeat(500), confirm: true }).ok, true);
});

t('an unknown target is blocked', () => {
  assert.equal(guardPost(cfg, { target: 'nope', text: 'hi', confirm: true }).ok, false);
});

process.stdout.write('\nshare: the edited body per site (the app’s text is not the person’s words)\n');
// The report is almost always longer than a site's limit, so what this app prepares can only be a starting
// point: a person edits it per site. Two rules follow and both are asserted here -- an edit wins over the
// prepared text **exactly as written**, and the compose link is measured against the edited body rather than
// the prepared one. `resolveSiteBody` is the one place that decides which text a site carries, so the page and
// the server cannot disagree about it.
const editedFixture = buildBundle({ items: Array.from({ length: 40 }, (_, i) => ({ id: 'e' + i, title: `一条很长的标题 ${i}` })) });

t('an edited body that fits produces a compose link, and the link carries the edited text', () => {
  const h = buildHandoff({ targetId: 'my-compose', bundle: editedFixture, cfg: composeSiteCfg, text: 'edited short body' });
  assert.equal(h.ok, true);
  assert.equal(h.textSource, 'edited');
  assert.equal(h.text, 'edited short body');
  assert.ok(h.composeUrl, 'the compose link is offered');
  assert.equal(new URL(h.composeUrl).searchParams.get('text'), 'edited short body');
});

t('a body edited past the limit gets no compose link, and is not cut to make one appear', () => {
  const long = 'y'.repeat(300); // my-compose takes 280
  const h = buildHandoff({ targetId: 'my-compose', bundle: editedFixture, cfg: composeSiteCfg, text: long });
  assert.equal(h.textSource, 'edited');
  assert.equal(h.fits, false);
  assert.equal(h.composeUrl, null, 'a truncated compose box is how half a post gets published');
  assert.equal(h.text, long, 'the edited text is still what the copy path carries');
  assert.ok(h.composeNote.en.includes('edited'), 'and the note says it is the edited body that does not fit');
});

t('the copy/hand-off path carries the edited text rather than the prepared one', () => {
  const edited = buildHandoff({ targetId: 'weibo-post', bundle: editedFixture, cfg: {}, text: 'my own words for weibo' });
  assert.equal(edited.text, 'my own words for weibo');
  assert.notEqual(edited.text, edited.preparedText);
  const prepared = buildHandoff({ targetId: 'weibo-post', bundle: editedFixture, cfg: {} });
  assert.equal(prepared.textSource, 'prepared');
  assert.equal(prepared.text, prepared.preparedText);
});

t('the prepared text travels with the hand-off, labelled as the app’s (so the page can offer a way back)', () => {
  const h = buildHandoff({ targetId: 'weibo-post', bundle: editedFixture, cfg: {}, text: 'mine' });
  assert.ok(h.preparedText.length > 0, 'the app’s own text is still available');
  assert.ok(h.preparedText !== h.text);
  const body = resolveSiteBody({ text: null, bundle: editedFixture, profile: { textLimit: 500 } });
  assert.equal(body.source, 'prepared');
  assert.ok(body.text.length <= 500);
});

t('an emptied body is an edit too (it means "do not send the app’s report"), not "no text given"', () => {
  const body = resolveSiteBody({ text: '', bundle: editedFixture, profile: { textLimit: 500 } });
  assert.equal(body.source, 'edited');
  assert.equal(body.text, '');
});

vacuously(
  'the compose link follows the edited body (wrong input: a body edited past the limit)',
  (h) => (h.composeUrl ? [] : ['no compose link was produced']),
  () => buildHandoff({ targetId: 'my-compose', bundle: editedFixture, cfg: composeSiteCfg, text: 'short edited body' }),
  () => buildHandoff({ targetId: 'my-compose', bundle: editedFixture, cfg: composeSiteCfg, text: 'z'.repeat(300) })
);

vacuously(
  'the hand-off carries the text it was given (wrong input: the prepared body while an edit exists)',
  (h) => (h.text === 'my edited words' ? [] : [`expected the edited text, got ${JSON.stringify(String(h.text).slice(0, 30))}`]),
  () => buildHandoff({ targetId: 'weibo-post', bundle: editedFixture, cfg: {}, text: 'my edited words' }),
  () => buildHandoff({ targetId: 'weibo-post', bundle: editedFixture, cfg: {} })
);

process.stdout.write('\nshare: controls (a check that cannot fail is not a check)\n');
// Each family is: one check function, run once on a freshly built right input and once on a freshly built
// deliberately wrong one. If the wrong input passes as well, the family is reported as a failure above.
const imageFixture = [{ id: 'img-1', title: 'one item carrying three source images', images: ['u1', 'u2', 'u3'] }];
const bundleWithImages = (maxPerBundle) =>
  buildBundle({ items: imageFixture, title: 'x', images: { mode: 'source', maxPerBundle }, maxImages: 9 });

vacuously(
  'the bundle attaches exactly the number of images the setting asks for (wrong input: 3 instead of 1)',
  (b) => {
    const got = b.items[0].images.length;
    return got === 1 ? [] : [`expected exactly 1 attached image, got ${got}`];
  },
  () => bundleWithImages(1),
  () => bundleWithImages(3)
);

vacuously(
  'the account stage reports exactly which requirement is unsatisfied (wrong input: an account that satisfies everything)',
  (accounts) => {
    const r = stageReport(targetById('weibo-post'), accounts, {});
    const missing = r.account.unsatisfied.map((u) => u.id).join(',');
    return missing === 'csrf' ? [] : [`expected the exact missing set, got "${missing}"`];
  },
  () => [accountOf('weibo', { hasCsrf: false, canSend: false })],
  () => [accountOf('weibo')]
);

vacuously(
  'the verification stage only turns done from a stored pass for that account (wrong input: a pass for another account)',
  (store) => {
    const stage = stageReport(targetById('weibo-post'), [accountOf('weibo')], store);
    return stage.verification.status === 'done' ? [] : [`expected done for acc-1, got ${stage.verification.status}`];
  },
  () => recordVerification({}, 'weibo-post', 'acc-1', { at: new Date().toISOString(), ok: true }),
  () => recordVerification({}, 'weibo-post', 'acc-2', { at: new Date().toISOString(), ok: true })
);

vacuously(
  'the send gate opens exactly when the account has a fresh measured pass (wrong input: no pass at all)',
  (verified) => {
    const g = guardPost(implementedSiteCfg, { target: 'my-site', accounts: [accountOf('weibo')], verified, text: 'hi', confirm: true });
    return g.ok ? [] : [`expected the gate to open, it said: ${g.error}`];
  },
  () => recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true }),
  () => ({})
);

vacuously(
  'a declared but unimplemented site cannot be posted to (wrong input: the same site with a publish implementation)',
  (c) => {
    const g = guardPost(c, {
      target: 'my-site',
      accounts: [accountOf('weibo')],
      text: 'hi',
      confirm: true,
      verified: recordVerification({}, 'my-site', 'acc-1', { at: new Date().toISOString(), ok: true }),
    });
    return g.ok ? [] : [`expected the site to be postable once implemented, it said: ${g.error}`];
  },
  () => ({ share: { sites: [{ ...customCfg.share.sites[0], implemented: true }] } }),
  () => customCfg
);

vacuously(
  'the stage-to-UI mapping points at a real entry (wrong input: a mapping that lacks the entry the stage uses)',
  (mapping) => {
    // The "missing account" state is used here on purpose: with a usable account the account stage maps to
    // shareReady, which even the deliberately narrowed mapping contains, and the control would be blind.
    const r = stageReport(targetById('weibo-post'), [], {});
    return mapping.has(r.account.i18nKey) ? [] : [`"${r.account.i18nKey}" is not a UI entry`];
  },
  () => new Set(['shareReady', 'shareNeedsLogin', 'shareNeedsVerify', 'shareUnsupported', 'shareUnsupportedShort', 'shareCannotWithoutLogin', 'yes']),
  () => new Set(['shareReady'])
);

vacuously(
  'a measurement result is stored for the account it was measured with (wrong input: stored under another key)',
  (key) => {
    const store = recordVerification({}, 'weibo-post', key, { at: new Date().toISOString(), ok: true });
    return verificationFor(store, 'weibo-post', 'acc-1') ? [] : ['the result was not found under acc-1'];
  },
  () => 'acc-1',
  () => 'acc-1-typo'
);

// The dictionary lookup itself, exercised through a function so the "key that does not exist" case can be fed
// in without touching the module (the module's own mapping is checked separately, against the real file).
const findInDict = (payload) => {
  const bad = [];
  for (const [stage, states] of Object.entries(payload.table)) {
    for (const [state, key] of Object.entries(states)) {
      if (!payload.dicts.zh.has(key) || !payload.dicts.en.has(key)) bad.push(`${stage}/${state} -> ${key} is not a known entry`);
    }
  }
  return bad;
};

/** Fixtures for the control families: one bundle too long for a 280-character site, and two accounts of one kind */
const longHandoffBundle = () =>
  buildBundle({ items: Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, title: '一条很长的标题 ' + i })) });
const accountA = accountOf('weibo', { id: 'acc-a', name: 'account-a' });
const accountB = accountOf('weibo', { id: 'acc-b', name: 'account-b' });
const settingsBefore = () => ({
  share: {
    images: { mode: 'source', maxPerBundle: 2, inlineMaxBytes: 1000 },
    accounts: { 'weibo-post': 'acc-1' },
    sites: [{ id: 'keep-me', name: { zh: 'a', en: 'a' }, loginKind: 'reddit' }],
  },
});

vacuously(
  'the stage-to-dictionary mapping really resolves (wrong input: one mapping renamed to a key that does not exist)',
  findInDict,
  () => ({ dicts: DICTS, table: STAGE_I18N }),
  () => ({ dicts: DICTS, table: { ...STAGE_I18N, account: { ...STAGE_I18N.account, missing: 'shareNeedLoginTypo' } } })
);

vacuously(
  'the API contract of a target really is checked (wrong input: one stage loses a field the page reads)',
  (list) => {
    const bad = [];
    for (const x of list) {
      for (const key of ['account', 'verification', 'send']) {
        const s = x.stages?.[key];
        if (!s) bad.push(`${x.id} has no ${key} stage`);
        else if (typeof s.actionable !== 'boolean') bad.push(`${x.id}/${key} does not say whether it can be acted on`);
      }
    }
    return bad;
  },
  () => stagesReport([], {}, {}),
  () => {
    const list = stagesReport([], {}, {});
    // drop `actionable` from the one target whose login stage has nothing left to run (a hostless site)
    const x = list.find((t) => t.id === 'mastodon-post');
    delete x.stages.verification.actionable;
    return list;
  }
);

process.stdout.write('\nshare: manual hand-off for a site this build cannot post to\n');
// A body with the three characters that actually break a hand-built URL: `&` (a second query parameter),
// `#` (a fragment) and spaces. A hand-off that "encodes" by string concatenation loses the tail of the post.
const handoffBody = 'VML 日报 & 摘要 #1\n· 第一条 https://example.com/a?x=1&y=2';

t('a site with no publish code produces a hand-off that carries the body and a compose link', () => {
  const b = buildBundle({ items, title: 'VML 日报' });
  const h = buildHandoff({ targetId: 'my-compose', bundle: b, cfg: composeSiteCfg });
  assert.equal(h.ok, true);
  assert.equal(h.manual, true);
  assert.equal(h.sent, false, 'a hand-off never sends');
  assert.equal(h.posted, false, 'and it must not read as posted');
  assert.ok(h.postedNote.zh && h.postedNote.en, 'it says so in words as well');
  assert.ok(h.needs.zh && h.needs.en, 'and it says what the user has to bring');
  assert.ok(h.text.length > 0);
  assert.ok(h.site.textLimit > 0);
  const u = new URL(h.composeUrl);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, 'example.social', 'the compose link points at the site the profile declares');
});

t('the compose URL is really encoded: &, # and spaces survive the round trip', () => {
  const h = buildHandoff({ targetId: 'my-compose', bundle: buildBundle({ items: [{ id: 'i', title: handoffBody }] }), cfg: composeSiteCfg });
  const u = new URL(h.composeUrl);
  const back = u.searchParams.get('text');
  assert.ok(back, 'the text parameter is present');
  assert.ok(back.includes('&'), 'the ampersand survived instead of starting a new parameter');
  assert.ok(back.includes('#'), 'the hash survived instead of becoming a fragment');
  assert.ok(back.includes(' '), 'the spaces survived instead of turning into a broken URL');
  assert.ok(back.includes('摘要'), 'the body is the prepared text, not a summary');
  assert.equal(new URLSearchParams(u.search).get('text'), back, 'exactly one text parameter');
});

t('a body over the site limit does not get a truncated compose box', () => {
  const long = buildBundle({ items: Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, title: '一条很长的标题 ' + i })) });
  const h = buildHandoff({ targetId: 'my-compose', bundle: long, cfg: composeSiteCfg });
  assert.equal(h.truncated, true);
  assert.equal(h.fits, false);
  assert.equal(h.composeUrl, null, 'no compose link when the whole body does not fit');
  assert.ok(h.composeNote.zh.includes(String(h.textLimit)), h.composeNote.zh);
  assert.ok(h.text.length <= h.textLimit, `the prepared text must respect the limit: ${h.text.length} > ${h.textLimit}`);
  assert.ok(h.text.includes('cut to fit the limit'), 'and it says in the text itself that it was cut: ' + h.text.slice(-80));
});

t('truncation cuts on a line boundary and keeps its marker inside the limit', () => {
  const text = Array.from({ length: 30 }, (_, i) => 'line-' + i + '-padding').join('\n');
  for (const limit of [40, 80, 120, 200]) {
    const r = truncateForSite(text, limit);
    assert.ok(r.text.length <= limit, `limit ${limit}: got ${r.text.length}`);
    assert.equal(r.truncated, true);
    assert.ok(r.droppedLines > 0);
    assert.ok(r.text.includes('cut to fit the limit'), 'the marker is inside the limit as well: ' + JSON.stringify(r.text.slice(-60)));
    assert.ok(!r.text.includes('\nundefined'), 'no half-written line');
  }
  const fits = truncateForSite('short body', 100);
  assert.equal(fits.truncated, false);
  assert.equal(fits.text, 'short body');
});

t('building a hand-off makes no network call at all (text and links only)', () => {
  // The proof is structural and can be read off the code: buildHandoff is not an async function and calls
  // nothing that returns a promise, while every network path in this module goes through netFetch/async
  // functions. The check states the property that is being relied on -- "you get an object back, not a
  // promise" -- so a future edit that sneaks a fetch in has to change that shape first.
  const h = buildHandoff({ targetId: 'my-compose', bundle: buildBundle({ items, title: 'x' }), cfg: composeSiteCfg });
  assert.equal(typeof h.then, 'undefined', 'a hand-off is computed, not fetched');
  assert.ok(!('cookieHeader' in h) && !('response' in h), 'and nothing from the network is in it');
  assert.equal(JSON.stringify(h).includes('SESSDATA'), false, 'no credential material ends up in a hand-off');
});

t('a site with no compose template still gets a hand-off (copy and download are the path)', () => {
  const cfgNoCompose = { share: { sites: [{ id: 'no-compose', name: { zh: '无发布页', en: 'no compose' }, loginKind: 'reddit', requirements: ['login', 'token'], textLimit: 100 }] } };
  const h = buildHandoff({ targetId: 'no-compose', bundle: buildBundle({ items, title: 'x' }), cfg: cfgNoCompose });
  assert.equal(h.ok, true);
  assert.equal(h.composeUrl, null);
  assert.equal(h.text.length > 0, true);
  assert.ok(h.composeNote.zh.length > 0, 'and it says why there is no link');
});

t('the hand-off carries the image setting resolved against the site, not the page default', () => {
  const cfg = { share: { images: { mode: 'inline', maxPerBundle: 4 } } };
  const h = buildHandoff({ targetId: 'reddit-post', bundle: buildBundle({ items, title: 'x' }), cfg });
  assert.equal(h.images.mode, 'inline');
  assert.equal(h.images.maxPerBundle, 4, 'reddit takes 20 images and the setting is 4, so the setting is the limit');
  const small = buildHandoff({ targetId: 'youtube-community', bundle: buildBundle({ items, title: 'x' }), cfg });
  assert.equal(small.images.maxPerBundle, 1, 'the site ceiling wins when it is smaller (YouTube community: 1)');
});

t('a site this build CAN post to is not offered a hand-off (the manual path must not shadow the real one)', () => {
  // No built-in site claims publish code, so the shape is exercised on a declared one.
  const declaredImplemented = { share: { sites: [{ ...customCfg.share.sites[0], implemented: true }] } };
  const h = buildHandoff({ targetId: 'my-site', bundle: buildBundle({ items, title: 'x' }), cfg: declaredImplemented });
  assert.equal(h.ok, false);
  assert.ok(h.error.includes('implemented'), h.error);
});

t('every site that cannot publish declares how to hand it over', () => {
  for (const site of SHARE_SITES.filter((s) => !s.implemented)) {
    assert.ok(site.manual, site.id + ' has no manual path');
    assert.ok(site.manual.needs?.zh && site.manual.needs?.en, site.id + ' does not say what the user has to bring');
    assert.equal(typeof site.manual.images, 'boolean', site.id + ' does not say whether images are accepted');
    if (site.manual.compose) {
      // The template has to survive being filled: a placeholder nothing fills would produce a broken link.
      const filled = site.manual.compose.replace(/\{text\}/g, 'x').replace(/\{title\}/g, 'x').replace(/\{instance\}/g, 'mastodon.social');
      assert.doesNotThrow(() => new URL(filled), site.id + ' has a compose template that does not parse once filled');
    }
  }
  // Mastodon's compose page lives on the user's own instance, so its template must keep a placeholder
  const mastodon = SHARE_SITES.find((s) => s.id === 'mastodon-post');
  assert.ok(mastodon.manual.compose.includes('{instance}'), 'the instance has to stay a placeholder');
});

t('a hand-off of a non-posting target is refused', () => {
  const h = buildHandoff({ targetId: 'file-html', bundle: buildBundle({ items }), cfg: {} });
  assert.equal(h.ok, false);
});

process.stdout.write('\nshare: configuring sites and settings\n');
t('a hand-added site is normalized: requirements come from what this build can check, and it may declare a compose page', () => {
  const oauth = sanitizeSiteEntry({ id: 'my-blog', name: { zh: '我的博客', en: 'my blog' }, loginKind: 'reddit' });
  assert.equal(oauth.ok, true);
  assert.deepEqual(oauth.site.requirements, ['login', 'token', 'scope'], 'oauth kind: what can be checked is token and scope');
  assert.equal(oauth.site.implemented, false, 'a form can never claim the app can publish');
  assert.equal(oauth.site.verify, null, 'no probe exists for that kind, and the entry must not pretend one does');
  const cookie = sanitizeSiteEntry({ id: 'my-bbs', loginKind: 'weibo' });
  assert.deepEqual(cookie.site.requirements, ['login', 'session', 'csrf']);
  const none = sanitizeSiteEntry({ id: 'open-board', loginKind: null });
  assert.deepEqual(none.site.requirements, ['anonymous'], 'no login still has to declare something to check');
  const withCompose = sanitizeSiteEntry({ id: 'my-forum', loginKind: 'weibo', manual: { compose: 'https://forum.example.com/new?body={text}' } });
  assert.equal(withCompose.site.manual.compose, 'https://forum.example.com/new?body={text}');
  const retired = sanitizeSiteEntry({ id: 'my-old-site', loginKind: 'bilibili' });
  assert.equal(retired.ok, false, 'a login kind this build does not know must be refused, not stored');
});

t('a hand-added site with a bad id or a bad compose URL is refused with a reason', () => {
  assert.equal(sanitizeSiteEntry({ id: 'a' }).ok, false, 'too short');
  assert.equal(sanitizeSiteEntry({ id: 'has space' }).ok, false);
  assert.equal(sanitizeSiteEntry({ id: 'weibo-post' }).ok, false, 'a built-in id may not be shadowed');
  assert.equal(sanitizeSiteEntry({ id: 'ok-site', loginKind: 'myspace' }).ok, false, 'unknown login kind');
  const javascript = sanitizeSiteEntry({ id: 'ok-site', loginKind: 'reddit', manual: { compose: 'javascript:alert(1)?text={text}' } });
  assert.equal(javascript.ok, true);
  assert.equal(javascript.site.manual, null, 'only http(s) compose pages are accepted');
});

t('settings changes are merged, not replaced (a partial write must not delete what was not sent)', () => {
  const before = { share: { images: { mode: 'source', maxPerBundle: 2, inlineMaxBytes: 1000 }, sites: [{ id: 'keep-me', name: { zh: 'a', en: 'a' }, loginKind: 'reddit' }], accounts: { 'weibo-post': 'acc-1' } } };
  const after = applyShareSettings(before, { images: { mode: 'inline' } });
  assert.equal(after.share.images.mode, 'inline');
  assert.equal(after.share.images.maxPerBundle, 2, 'the count was not sent, so it must survive');
  assert.equal(after.share.images.inlineMaxBytes, 1000);
  assert.deepEqual(after.share.accounts, { 'weibo-post': 'acc-1' }, 'accounts survive an image-only patch');
  const withSite = applyShareSettings(after, { sites: [{ id: 'new-one', loginKind: 'mastodon' }] });
  assert.deepEqual(withSite.share.sites.map((s) => s.id).sort(), ['keep-me', 'new-one'], 'adding a site must not remove the others');
  const removed = applyShareSettings(withSite, { removeSites: ['keep-me'] });
  assert.deepEqual(removed.share.sites.map((s) => s.id), ['new-one']);
  const bad = applyShareSettings(before, { sites: [{ id: 'bad id' }] });
  assert.ok(bad.sitesError, 'a rejected entry is reported, not dropped quietly');
  assert.equal(bad.share.sites.length, 1, 'and it does not enter the list');
});

t('an unknown account choice is ignored instead of being stored as-is', () => {
  const cfg = { share: { accounts: {} } };
  const after = applyShareSettings(cfg, { accounts: { 'weibo-post': 'acc-1', 'not-a-target': 'acc-2' } });
  assert.deepEqual(after.share.accounts, { 'weibo-post': 'acc-1' });
  const cleared = applyShareSettings(after, { accounts: { 'weibo-post': null } });
  assert.equal('weibo-post' in cleared.share.accounts, false);
});

t('the chosen account is used when it still exists, and the automatic pick when it does not', () => {
  const accounts = [
    accountOf('weibo', { id: 'acc-a', name: 'a' }),
    accountOf('weibo', { id: 'acc-b', name: 'b' }),
  ];
  assert.equal(pickAccountId('weibo-post', accounts, { share: { accounts: { 'weibo-post': 'acc-b' } } }), 'acc-b');
  assert.equal(pickAccountId('weibo-post', accounts, { share: { accounts: { 'weibo-post': 'gone' } } }), null, 'a stale choice falls back to the automatic pick');
  assert.equal(pickAccountId('weibo-post', accounts, {}), null);
  const r = stageReport(targetById('weibo-post'), accounts, {}, { cfg: { share: { accounts: { 'weibo-post': 'acc-b' } } } });
  assert.equal(r.account.accountName, 'b', 'the stored choice is what the stage reports');
});

t('the account chooser lists what each candidate already satisfies', () => {
  const accounts = [
    accountOf('weibo', { id: 'acc-a', name: 'a', hasCsrf: false, canSend: false }),
    accountOf('weibo', { id: 'acc-b', name: 'b' }),
    accountOf('mastodon', { id: 'acc-m', name: 'm' }),
  ];
  const list = accountsForTarget('weibo-post', accounts, {});
  assert.equal(list.length, 2, 'only the accounts of this site login kind: ' + JSON.stringify(list.map((a) => a.id)));
  assert.equal(list.find((a) => a.id === 'acc-a').usable, false);
  assert.deepEqual(list.find((a) => a.id === 'acc-a').unsatisfied.map((u) => u.id), ['csrf']);
  assert.equal(list.find((a) => a.id === 'acc-b').usable, true);
  assert.deepEqual(accountsForTarget('text', accounts, {}), [], 'a file target has no accounts to choose from');
});

t('the requirement checklist is only built when it is asked for, and it names what cannot be checked', () => {
  const accounts = [accountOf('weibo', { id: 'acc-a', name: 'a', hasCsrf: false, canSend: false })];
  const plain = stageReport(targetById('weibo-post'), accounts, {});
  assert.equal(plain.account.requirementRows, undefined, 'the list is opt-in (the target list is polled)');
  const withRows = stageReport(targetById('weibo-post'), accounts, {}, { requirementRows: true });
  const rows = withRows.account.requirementRows;
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.id === 'csrf').satisfied, false, 'the missing CSRF token is visible in the checklist');
  assert.equal(rows.find((r) => r.id === 'login').satisfied, true);
  assert.equal(rows.every((r) => r.checkable), true, 'every requirement of this kind is measurable here');
  // A requirement nothing can measure must say so rather than show as satisfied
  const custom = siteProfileById('no-compose', { share: { sites: [{ id: 'no-compose', loginKind: 'reddit', requirements: ['login', 'token', 'mystery'] }] } });
  assert.equal(custom.requirements.includes('mystery'), true);
  const r2 = stageReport({ id: 'no-compose', kind: 'post', needsLogin: true, status: 'unimplemented' }, [{ id: 'x', kind: 'reddit', hasToken: true, hasScope: true }], {}, { cfg: { share: { sites: [{ id: 'no-compose', loginKind: 'reddit', requirements: ['login', 'token', 'mystery'] }] } }, requirementRows: true });
  const mystery = r2.account.requirementRows.find((r) => r.id === 'mystery');
  assert.equal(mystery.checkable, false, 'a requirement with no measurement is marked as such');
  assert.equal(mystery.satisfied, null, 'and it is neither satisfied nor unsatisfied');
});

t('what gets stored is (target, account) with a date and a verdict, nothing else', () => {
  const store = recordVerification({}, 'weibo-post', 'acc-1', { at: '2026-09-16T00:00:00.000Z', ok: true, detail: { zh: 'x', en: 'x' }, reason: null });
  const slim = verifiedByTarget(store);
  assert.deepEqual(slim, { 'weibo-post': { 'acc-1': { at: '2026-09-16T00:00:00.000Z', ok: true } } });
});

t('what a site would carry is built from the items, titled and linked, not dumped as JSON', () => {
  const text = renderSiteText(buildBundle({ items, title: 'x', subtitle: '示例', note: '由 VML 生成' }));
  assert.ok(text.includes('· 嘉然 3D披露'));
  assert.ok(text.includes('https://example.com/a1'));
  assert.ok(!text.includes('{'), 'no JSON braces in a post body');
});

t('rendering the site text and truncating it is pure (no network, no bundle mutation)', () => {
  const b = buildBundle({ items, title: 'x' });
  const before = JSON.stringify(b);
  const t1 = renderSiteText(b);
  truncateForSite(t1, 20);
  assert.equal(JSON.stringify(b), before, 'the bundle was not modified');
  assert.equal(typeof truncateForSite(t1, 20).then, 'undefined');
});

vacuously(
  'the hand-off really encodes the body into the compose URL (wrong input: the same URL built by concatenation)',
  (payload) => {
    // The round trip is what matters: whatever the encoding scheme, reading the parameter back has to return
    // the prepared body character for character.
    let back = null;
    try {
      back = new URL(payload.url).searchParams.get('text');
    } catch {
      return ['the compose URL does not parse'];
    }
    return back === payload.wanted ? [] : [`the text parameter came back as ${JSON.stringify(String(back).slice(0, 40))}`];
  },
  () => {
    const bundle = buildBundle({ items, title: 'VML 日报' });
    return { url: buildHandoff({ targetId: 'my-compose', bundle, cfg: composeSiteCfg }).composeUrl, wanted: renderSiteText(bundle) };
  },
  () => ({ url: 'https://example.social/publish?text=' + renderSiteText(buildBundle({ items, title: 'VML 日报' })), wanted: renderSiteText(buildBundle({ items, title: 'VML 日报' })) }) // what naive concatenation produces
);

vacuously(
  'a body over the limit is prepared as a cut body instead of a truncated compose box (wrong input: a limit it fits in)',
  (h) => (h.fits === false && h.composeUrl === null ? [] : ['the hand-off did not treat the body as one that does not fit']),
  () => buildHandoff({ targetId: 'my-compose', bundle: longHandoffBundle(), cfg: composeSiteCfg }),
  // A declared site with the same compose template but a limit the body fits in: the only difference from the
  // right input is the limit, so a check that fires here is measuring the limit and nothing else.
  () =>
    buildHandoff({
      targetId: 'ctrl-roomy',
      bundle: longHandoffBundle(),
      cfg: { share: { sites: [{ id: 'ctrl-roomy', loginKind: 'mastodon', textLimit: 50000, manual: { compose: 'https://example.social/publish?text={text}' } }] } },
    })
);

// The other two properties of a cut body, asserted on their own so the control above stays precise
// (one wrong fact, one firing check -- a control that fires twice is reporting something else as well).
t('a cut body says so in the text and stays inside the limit it was cut for', () => {
  const h = buildHandoff({ targetId: 'my-compose', bundle: longHandoffBundle(), cfg: composeSiteCfg });
  assert.ok(h.text.length <= h.textLimit, `${h.text.length} > ${h.textLimit}`);
  assert.ok(h.text.includes('cut to fit the limit'), 'the marker has to be inside the text: ' + h.text.slice(-70));
  assert.ok(h.composeNote.zh.includes(String(h.textLimit)), h.composeNote.zh);
});

vacuously(
  'the hand-off is only offered where the app cannot publish (wrong input: the site that IS implemented)',
  (h) => (h.ok === false ? [] : ['a hand-off was offered for a site this build can post to']),
  () => buildHandoff({ targetId: 'my-site', bundle: buildBundle({ items, title: 'x' }), cfg: { share: { sites: [{ ...customCfg.share.sites[0], implemented: true }] } } }),
  () => buildHandoff({ targetId: 'reddit-post', bundle: buildBundle({ items, title: 'x' }), cfg: {} })
);

vacuously(
  'a hand-added site declares what can be checked for its login kind (wrong input: the cookie kind instead of the token kind)',
  (site) => (JSON.stringify(site.requirements) === JSON.stringify(['login', 'token', 'scope']) ? [] : [`requirements were ${JSON.stringify(site.requirements)}`]),
  () => sanitizeSiteEntry({ id: 'ctrl-oauth', loginKind: 'reddit' }).site,
  () => sanitizeSiteEntry({ id: 'ctrl-cookie', loginKind: 'weibo' }).site
);

vacuously(
  'a settings patch merges instead of replacing (wrong input: a patch that drops the other keys)',
  (share) => {
    const bad = [];
    if (share.images.mode !== 'inline') bad.push('the new mode was not applied');
    if (share.images.maxPerBundle !== 2) bad.push('the untouched image count was lost');
    if (!share.accounts?.['weibo-post']) bad.push('the untouched account choice was lost');
    if (share.sites?.length !== 1) bad.push('the untouched declared site was lost');
    return bad;
  },
  () => applyShareSettings(settingsBefore(), { images: { mode: 'inline' } }).share,
  () => ({ ...settingsBefore().share, images: { mode: 'inline' } }) // a replace-shaped patch
);

vacuously(
  'the stored account choice is what the stage reports (wrong input: a choice made for another target)',
  (cfg) => {
    const r = stageReport(targetById('weibo-post'), [accountA, accountB], {}, { cfg });
    return r.account.accountName === accountB.name ? [] : [`the account stage reported ${r.account.accountName}`];
  },
  () => ({ share: { accounts: { 'weibo-post': accountB.id } } }),
  () => ({ share: { accounts: { 'youtube-community': accountB.id } } })
);

process.stdout.write('\nshare: audit\n');
t('the audit is writable, readable and append-only', () => {
  assert.equal(appendAudit(cfg, { action: 'download', target: 'file-html', items: 2 }), true);
  assert.equal(appendAudit(cfg, { action: 'post', target: 'weibo-post', ok: true }), true);
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

if (VACUOUS.length) {
  process.stdout.write('\nvacuous controls (each of these checks passed on the wrong input, so it proves nothing):\n');
  for (const v of VACUOUS) process.stdout.write('  ' + v.family + '\n');
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

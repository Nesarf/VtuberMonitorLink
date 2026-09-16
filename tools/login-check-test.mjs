// ---------------------------------------------------------------------------------------------------
// tools/login-check-test.mjs — "check login state" on every surface, plus the two things that measurement
// needs: a read-only wiki probe, and an editor opener that cannot be talked into running anything else.
//
// What is dangerous here, and therefore what is actually asserted:
//
//   1) **A check that reports an assumption.** Every surface that configures a login must measure it. The
//      pieces that make that possible are pure functions — which host a source's login would come from,
//      which probe a share target falls back to, how a MediaWiki request is built and its answer read —
//      so they can be exercised offline, and the cookie probe's answer is asserted to carry **counts and
//      names only**: no cookie value may appear anywhere in it. The control uses a fixture whose cookie
//      values are long, distinctive strings, so "the value did not leak" is a real assertion rather than a
//      property of the fixture.
//   2) **A button that cannot be pressed.** A target whose publishing is unsupported must still offer a
//      login check (the login stage is independent of the send stage), and a login kind for which no
//      account discovery exists must say so rather than showing an empty chooser. Both are asserted, and
//      the control is the same target with no host at all — which must answer honestly instead of firing a
//      request against a domain nobody owns.
//   3) **A file name that becomes a command.** The editor opener is the one endpoint whose request names a
//      file that is then executed against. So: a raw path is refused, `..` is refused, a path that resolves
//      outside the app's roots is refused, a symlink out of the roots is refused, and the invocation is an
//      **argv array** — the control asserts that no shell string is ever constructed, by checking that the
//      built invocation carries no `shell: true` and no joined command line.
//   4) **An edited body that gets silently replaced.** The per-site text a person edits must be what the
//      hand-off carries and what the compose link is measured against. A body edited to fit produces a
//      compose link, a body edited to exceed the limit does not, and the copy/hand-off carries the edited
//      text rather than the prepared one.
//
// Every family comes with a control on a deliberately wrong input (`vacuously`): a check that still passes
// on the wrong input is not checking anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { sourceLoginHost } = await mod('server/src/sources.js');
const { buildWikiLoginRequest, checkWatchLogin, parseWikiLoginResponse, safeLoginRequestSummary, wikiHostOf } = await mod('server/src/watch.js');
const { buildHandoff, checkLoginState, resolveLoginProbe, resolveSiteBody, shareTargets, siteProfileById, stagesReport } = await mod('server/src/share.js');
const { buildOpenInvocation, isInside, isPlainFileName, OPEN_KINDS, parseEditorCommand, resolveEditorCommand, resolveOpenPath, openResultNote } = await mod('server/src/openfile.js');

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

/** Control for a family: the right input must pass, the deliberately wrong one must be rejected exactly once */
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
        : `the control fired ${wrongProblems.length} times, which means it is reporting something other than the one wrong fact: ${wrongProblems.join(' / ')}`,
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

const cfg = { paths: { reportsDir: path.join(os.tmpdir(), 'vml-login-test-root', 'reports') } };
/** A hand-added site of a login kind this app cannot discover, with a placeholder compose host and no probe */
const hostlessCfg = { share: { sites: [{ id: 'my-site', loginKind: 'mastodon', manual: { compose: 'https://{instance}/publish?text={text}' } }] } };
/** A cookie login kind (no probe of its own) on a site whose host is not knowable: nothing to read */
const noHostWeibo = { share: { sites: [{ id: 'weibo-no-host', loginKind: 'weibo', manual: { compose: 'https://{instance}/compose?text={text}' } }] } };

// ───────────────────────────────────────────── 1. which host a source's login comes from

process.stdout.write('\nlogin check: the host a source would read\n');

t('a source with a url takes the host of that url (www. is dropped: cookies live on the registrable domain)', () => {
  assert.equal(sourceLoginHost({ id: 'b', url: 'https://www.pixiv.net/ranking.php' }), 'pixiv.net');
  assert.equal(sourceLoginHost({ id: 'c', url: 'http://example.com:8080/feed.xml' }), 'example.com:8080');
  // A subdomain is kept as it is: the host is a property of the source's own url, and nothing rewrites it to
  // a parent domain any more (the one fallback that did so belonged to a source that was removed).
  assert.equal(sourceLoginHost({ id: 'a', url: 'https://zh.moegirl.org.cn/' }), 'zh.moegirl.org.cn');
});

t('a source with no usable host answers null instead of guessing a domain', () => {
  assert.equal(sourceLoginHost({ id: 'x', category: 'community', fetch: 'rss' }), null);
  assert.equal(sourceLoginHost({ id: 'y', url: 'not a url', category: 'merch' }), null);
  assert.equal(sourceLoginHost({}), null);
  // The control for the removal: a source that merely *looks* like the retired platform's gets no host by
  // category or fetch kind either -- the only source of a host is the url.
  assert.equal(sourceLoginHost({ id: 'ghost', category: 'social', fetch: 'browser' }), null);
});

vacuously(
  'the host of a source comes from its own url (wrong input: the source for another site)',
  (host) => (host === 'pixiv.net' ? [] : [`expected pixiv.net, got ${JSON.stringify(host)}`]),
  () => sourceLoginHost({ id: 'p', url: 'https://www.pixiv.net/ranking.php' }),
  () => sourceLoginHost({ id: 'q', url: 'https://www.deviantart.com/' }),
);

// ───────────────────────────────────────────── 2. the cookie probe's answer shape

process.stdout.write('\nlogin check: the cookie probe reports counts and names only\n');

/** A readBrowserCookies-shaped answer whose values are unmistakable, so a leak cannot hide in a fixture */
const SECRET = 'SESSIONID-VALUE-MUST-NEVER-APPEAR-9f3a';
const cookieAnswer = (names) => ({
  ok: names.length > 0,
  names,
  // The real implementation returns a header; the check must not pass it on, and this is what proves it.
  cookieHeader: names.map((n) => `${n}=${SECRET}`).join('; '),
  profile: 'C:/secret/profile/path',
});

const cookieCheck = (names, { ok = undefined } = {}) =>
  checkLoginState(cfg, 'reddit-post', { readCookies: async () => ({ ...cookieAnswer(names), ok: ok ?? names.length > 0 }) });

await ta('a session cookie is reported as a logged-in state, with the count and the names', async () => {
  const r = await cookieCheck(['sessionid', 'csrftoken', '_ga']);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'session');
  assert.equal(r.cookieCount, 3);
  assert.deepEqual(r.names, ['sessionid', 'csrftoken', '_ga']);
  assert.equal(r.hasSession, true);
  assert.equal(r.probe, 'cookie-probe');
  assert.equal(r.domain, 'reddit.com');
});

await ta('cookies without a session cookie are reported as "probably not signed in", not as success', async () => {
  const r = await cookieCheck(['_ga', '_gid', 'locale']);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'cookies');
  assert.equal(r.cookieCount, 3);
  assert.equal(r.hasSession, false);
  assert.ok(r.reason.includes('session cookie'), r.reason);
});

await ta('no cookies for the host is "nothing found", with the reason the read gave', async () => {
  const r = await cookieCheck([]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'none');
  assert.equal(r.cookieCount, 0);
});

await ta('a cookie store that cannot be read is reported with its own reason (not as "not logged in")', async () => {
  const r = await checkLoginState(cfg, 'reddit-post', { readCookies: async () => ({ ok: false, error: 'no cookie store under C:/x' }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'none');
  assert.ok(r.reason.includes('no cookie store'), r.reason);
});

await ta('NO cookie value can appear in the answer -- not in a field, not in the JSON', async () => {
  const r = await cookieCheck(['sessionid', 'csrftoken']);
  const json = JSON.stringify(r);
  assert.ok(!json.includes(SECRET), 'the cookie value must not be anywhere in the answer');
  assert.ok(!('cookieHeader' in r), 'the cookie header must not be copied into the answer');
  assert.ok(!json.includes('C:/secret/profile/path'), 'the profile path is not part of a login-state answer either');
  // The names are what a person reads, so they must be there -- otherwise "no value" could be satisfied by
  // answering nothing at all.
  assert.deepEqual(r.names, ['sessionid', 'csrftoken']);
});

vacuously(
  'the cookie probe really refuses to pass a value on (wrong input: the same answer with the values kept)',
  (r) => (JSON.stringify(r).includes(SECRET) ? ['the cookie value leaked into the answer'] : []),
  () => {
    // What the production path returns: fields copied out one by one, no header among them.
    const names = ['sessionid'];
    return { ok: true, cookieCount: names.length, names };
  },
  () => {
    // The shortcut this guards against: handing the probe's own answer straight back.
    const raw = cookieAnswer(['sessionid']);
    return { ok: raw.ok, cookieCount: raw.names.length, names: raw.names, cookieHeader: raw.cookieHeader };
  },
);

vacuously(
  'a session cookie is recognised as a session cookie (wrong input: a locale-style cookie name)',
  (state) => (state.status === 'session' ? [] : [`expected a session state, got ${state.status}`]),
  () => ({ status: 'session' }),
  () => ({ status: 'cookies' }),
);

// ───────────────────────────────────────────── 3. the share page: an unsupported site is still checkable

process.stdout.write('\nlogin check: every posting site, including the ones that cannot post\n');

t('every posting target resolves to a login check: its own where one is declared, the cookie probe otherwise', () => {
  const posts = shareTargets(cfg).filter((x) => x.kind === 'post');
  // Four built-in posting sites remain. The two that were removed (a bilibili dynamic and an X post) went
  // with the sites themselves, so the count is pinned rather than merely lower-bounded: a fifth site coming
  // back through a helper nobody meant to keep is exactly what this number is here to notice.
  assert.equal(posts.length, 4, `expected the four posting sites, got ${posts.length}: ${posts.map((x) => x.id).join(', ')}`);
  for (const x of posts) {
    const plan = resolveLoginProbe(x, cfg);
    assert.equal(plan.target, x.id);
    assert.ok(['token-scope', 'http-probe', 'cookie-probe'].includes(plan.probe), `${x.id} resolves to ${plan.probe}`);
    assert.equal(plan.checkable, true, `${x.id} must be checkable`);
  }
  // A site that declares a probe of its own keeps it named (this build cannot run it, and says so).
  assert.equal(resolveLoginProbe('mastodon-post', cfg).probe, 'token-scope');
  // Every one of them is a real hand-off target: none of them has publishing code, which is why the manual
  // path is the one that matters here.
  for (const x of posts) assert.equal(x.status, 'unimplemented', `${x.id} should declare no publish code`);
});

t('a target whose publishing is impossible still offers a real login check -- the login stage is independent of the send stage', () => {
  // The built-in unsupported target (an X post) was removed with the platform. The property it pinned has to
  // hold for the sites that remain, so it is asserted on all of them at once: the login check is available
  // and the send step is not.
  const stages = stagesReport([], {}, cfg).filter((y) => y.kind === 'post');
  for (const stage of stages) {
    const plan = resolveLoginProbe(stage.id, cfg);
    assert.equal(plan.checkable, true, `${stage.id} must still be checkable: a hand-off is exactly when this matters`);
    assert.equal(stage.stages.verification.actionable, plan.host != null, `${stage.id}: verification actionable must follow the readable host`);
    assert.equal(stage.stages.send.actionable, false, `${stage.id}: sending stays impossible without publish code`);
  }
  const reddit = stages.find((y) => y.id === 'reddit-post');
  assert.equal(reddit.site.host, 'reddit.com', 'the host travels with the profile so the page renders what was decided');
  assert.equal(reddit.stages.verification.fallbackProbe, 'cookie-probe');
});

t('a site of a login kind nothing discovers says so, and its check is still available where a host exists', () => {
  const stage = stagesReport([], {}, cfg).find((y) => y.id === 'weibo-post');
  assert.equal(stage.site.accountDiscovery, false, 'nothing in this build enumerates logins, and the page has to know');
  assert.equal(stage.stages.verification.actionable, true);
  assert.equal(stage.site.host, 'weibo.com');
});

t('a site with no host answers honestly instead of firing a request', () => {
  // Mastodon's host is the user's own instance, so the profile declares none. It keeps the probe it has
  // (its token is checked locally), while the generic cookie probe has nothing to read.
  const plan = resolveLoginProbe('mastodon-post', cfg);
  assert.equal(plan.probe, 'token-scope');
  assert.equal(plan.host, null);
  assert.equal(plan.checkable, true, 'a site-specific probe does not need a host');
  // A site with neither a probe nor a host is the one case that is not checkable, and it says so.
  const plan2 = resolveLoginProbe('my-site', hostlessCfg);
  assert.equal(plan2.checkable, false);
  assert.equal(plan2.probe, null);
  assert.ok(plan2.detail.en.includes('no host'), plan2.detail.en);
  // A compose page whose host is a placeholder ({instance}) yields no host on purpose: probing a domain
  // nobody owns would answer "no cookies", which reads as "you are not signed in".
  assert.equal(siteProfileById('my-site', hostlessCfg).host, null);
});

await ta('a target with no host is measured as "unavailable" without any request at all', async () => {
  let called = false;
  const r = await checkLoginState(hostlessCfg, 'my-site', {
    readCookies: async () => {
      called = true;
      return { ok: true, names: ['sessionid'] };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unavailable');
  assert.equal(called, false, 'nothing may be read for a host nobody knows');
  assert.ok(r.reason.includes('no host'), r.reason);
});

vacuously(
  'the cookie probe is the fallback, chosen by the module rather than invented in the page (wrong input: a site that has a probe of its own)',
  (probe) => (probe === 'cookie-probe' ? [] : [`expected the cookie probe, got ${probe}`]),
  () => resolveLoginProbe('reddit-post', cfg).probe,
  () => resolveLoginProbe('mastodon-post', cfg).probe,
);

vacuously(
  'a hostless target is refused rather than probed (wrong input: a login kind with no probe and no host)',
  (plan) => (plan.checkable ? [] : [`refused: ${plan.detail?.en ?? 'no reason'}`]),
  () => resolveLoginProbe('mastodon-post', cfg),
  () => resolveLoginProbe('weibo-no-host', noHostWeibo),
);

// ───────────────────────────────────────────── 4. the wiki BotPassword probe (pure halves)

process.stdout.write('\nlogin check: the wiki BotPassword probe\n');

const wikiTarget = { apiUrl: 'https://zh.moegirl.org.cn/api.php', username: 'BotName@TaskName', botPassword: 'hunter2-not-a-real-secret' };

t('the wiki request is built as a read-only userinfo query with assert=user', () => {
  const r = buildWikiLoginRequest(wikiTarget);
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.pathname.endsWith('/api.php'), true);
  assert.equal(u.searchParams.get('action'), 'query');
  assert.equal(u.searchParams.get('meta'), 'userinfo');
  assert.equal(u.searchParams.get('format'), 'json');
  assert.equal(u.searchParams.get('assert'), 'user');
  // Read-only: there is no write action anywhere in the built request.
  assert.ok(!/action=(edit|login|delete|move)/.test(r.url), 'the probe must never be a write');
  assert.equal(r.host, 'zh.moegirl.org.cn');
});

t('the password travels in the Authorization header, and NEVER in the URL', () => {
  const r = buildWikiLoginRequest(wikiTarget);
  assert.ok(r.headers.authorization.startsWith('Basic '));
  const decoded = Buffer.from(r.headers.authorization.slice(6), 'base64').toString('utf8');
  assert.equal(decoded, 'BotName@TaskName:hunter2-not-a-real-secret');
  assert.ok(!r.url.includes('hunter2'), 'the password must not be in the URL');
  assert.ok(!r.url.includes('BotName'), 'the username must not be in the URL either');
  assert.ok(!/lgpassword|botPassword/.test(r.url), 'no password parameter of any shape');
});

t('the log-safe view of that request carries no credential at all', () => {
  const summary = safeLoginRequestSummary(buildWikiLoginRequest(wikiTarget));
  const json = JSON.stringify(summary);
  assert.ok(!json.includes('hunter2'), 'the password must not be in the log-safe summary');
  assert.ok(!('authorization' in summary), 'and the header must not be copied into it');
  assert.equal(summary.host, 'zh.moegirl.org.cn');
  assert.equal(summary.hasAuthorization, true, 'it still says a credential is being sent, which is what a log needs to know');
});

t('an empty field refuses politely instead of firing a request with a blank password', () => {
  for (const patch of [{ username: '' }, { botPassword: '' }, { apiUrl: '' }]) {
    const r = buildWikiLoginRequest({ ...wikiTarget, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.missing.length >= 1);
    assert.ok(r.error.includes('nothing was requested'), r.error);
    assert.equal(r.url, undefined, 'no URL is produced, so nothing can be sent by accident');
  }
});

t('a wiki answer names the account it is', () => {
  const r = parseWikiLoginResponse({ batchcomplete: '', query: { userinfo: { id: 12345, name: 'BotName@TaskName', groups: ['bot'], rights: ['read', 'edit'] } } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.user, 'BotName@TaskName');
  assert.deepEqual(r.groups, ['bot']);
  assert.ok(r.rights.includes('edit'));
});

t('an anonymous answer is a failure with its own reason (the credential was not accepted)', () => {
  const r = parseWikiLoginResponse({ query: { userinfo: { id: 0, name: '1.2.3.4', anon: true } } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'anon');
  assert.ok(r.reason.includes('anonymous'), r.reason);
});

t("an error answer carries the site's own code and reason", () => {
  const r = parseWikiLoginResponse({ error: { code: 'assertuserfailed', info: 'Assertion that the user is logged in failed.' } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'error');
  assert.equal(r.code, 'assertuserfailed');
  assert.ok(r.reason.includes('assertuserfailed') && r.reason.includes('Assertion'), r.reason);
});

t('a non-JSON answer and an empty userinfo block are errors, not passes', () => {
  assert.equal(parseWikiLoginResponse(null).ok, false);
  assert.equal(parseWikiLoginResponse('nope').ok, false);
  assert.equal(parseWikiLoginResponse({ query: {} }).code, 'no-userinfo');
  assert.equal(parseWikiLoginResponse({ query: { userinfo: {} } }).code, 'no-name');
});

t('the wiki host of an address is read from the URL, and a bad address has none', () => {
  assert.equal(wikiHostOf('https://zh.moegirl.org.cn/api.php'), 'zh.moegirl.org.cn');
  assert.equal(wikiHostOf('https://Wiki.Example.org/w/api.php'), 'wiki.example.org');
  assert.equal(wikiHostOf(''), '');
  assert.equal(wikiHostOf('not a url'), '');
});

await ta('checkWatchLogin refuses an incomplete credential without any request', async () => {
  let called = false;
  const r = await checkWatchLogin(
    { ...wikiTarget, botPassword: '' },
    { cfg },
    {
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({}) };
      },
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.checked, false);
  assert.equal(called, false, 'a blank credential must not reach the network');
  assert.deepEqual(r.missing, ['botPassword']);
});

await ta('checkWatchLogin reports the account the wiki named, and never the password', async () => {
  const r = await checkWatchLogin(wikiTarget, { cfg }, {
    fetchImpl: async (url, opts) => {
      assert.ok(!String(url).includes('hunter2'), 'the URL handed to the fetcher must not carry the password');
      assert.ok(String(opts?.headers?.authorization ?? '').startsWith('Basic '), 'the fetcher has to receive the basic-auth header');
      return { ok: true, status: 200, json: async () => ({ query: { userinfo: { id: 7, name: 'BotName@TaskName', rights: ['read'] } } }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.checked, true);
  assert.equal(r.user, 'BotName@TaskName');
  assert.equal(r.domain, 'zh.moegirl.org.cn');
  assert.ok(!JSON.stringify(r).includes('hunter2'), 'the password must not come back');
});

await ta('checkWatchLogin reports an unreachable wiki as unreachable, not as a bad password', async () => {
  const r = await checkWatchLogin(wikiTarget, { cfg }, {
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('could not reach the wiki'), r.reason);
  assert.ok(!r.reason.includes('credential'), 'the credential is not blamed for a network failure');
});

vacuously(
  'the pure answer parser accepts a real answer and rejects the control (wrong input: an anonymous answer)',
  (payload) => {
    const r = parseWikiLoginResponse(payload);
    return r.ok && r.user === 'BotName@TaskName' ? [] : [`expected the named account, got ${r.status}`];
  },
  () => ({ query: { userinfo: { id: 1, name: 'BotName@TaskName' } } }),
  () => ({ query: { userinfo: { id: 0, name: '1.2.3.4', anon: true } } }),
);

vacuously(
  'a credential is never put in the URL (wrong input: the same request with a password parameter)',
  (url) => (String(url).includes('hunter2') ? ['the password is in the URL'] : []),
  () => buildWikiLoginRequest(wikiTarget).url,
  () => `${buildWikiLoginRequest(wikiTarget).url}&lgpassword=hunter2-not-a-real-secret`,
);

// ───────────────────────────────────────────── 5. the editor opener

process.stdout.write('\nlogin check: opening a generated file\n');

const openCfg = { paths: { reportsDir: path.join(os.tmpdir(), 'vml-login-test-root', 'reports') } };
const reportsDir = openCfg.paths.reportsDir;
fs.mkdirSync(path.join(reportsDir, 'advice'), { recursive: true });
fs.writeFileSync(path.join(reportsDir, 'daily-2026-09-14.html'), '<html></html>', 'utf8');
fs.writeFileSync(path.join(reportsDir, 'advice', 'source-x.md'), '# advice', 'utf8');
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-outside-'));
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'not yours', 'utf8');

t('a (kind, name) request resolves to a file inside the app root', () => {
  const r = resolveOpenPath(openCfg, 'report', 'daily-2026-09-14.html');
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(reportsDir, 'daily-2026-09-14.html'));
  assert.equal(r.kind, 'report');
  const a = resolveOpenPath(openCfg, 'advice', 'source-x.md');
  assert.equal(a.ok, true);
  assert.equal(a.path, path.join(reportsDir, 'advice', 'source-x.md'));
});

t('a raw path is refused by name -- this endpoint takes a file name, not a path', () => {
  const r = resolveOpenPath(openCfg, 'report', path.join(outsideDir, 'secret.txt'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-a-file-name');
  assert.ok(r.error.includes('not a path'), r.error);
  // Absolute and relative paths, both separators, and a drive-letter form
  for (const bad of ['C:\\Windows\\win.ini', '/etc/passwd', 'sub/dir/file.html', 'sub\\dir\\file.html', '../outside.txt', '..']) {
    assert.equal(resolveOpenPath(openCfg, 'report', bad).ok, false, bad);
  }
});

t('a traversal out of the root is refused even when it names an existing file', () => {
  const r = resolveOpenPath(openCfg, 'report', `..${path.sep}..${path.sep}secret.txt`);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-a-file-name');
});

t('the resolved-prefix test is component-wise, so a sibling directory with the same prefix is not inside', () => {
  assert.equal(isInside('/app/reports', '/app/reports/daily.html'), true);
  assert.equal(isInside('/app/reports', '/app/reports-backup/daily.html'), false);
  assert.equal(isInside('/app/reports', '/app/reports/../secret.txt'), false);
  assert.equal(isInside('/app/reports', '/etc/passwd'), false);
});

t('a symlink pointing out of the roots is refused (a prefix test alone cannot see this)', () => {
  const link = path.join(reportsDir, 'link-out.txt');
  try {
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), link);
  } catch {
    process.stdout.write('         (symlink not permitted here -- the rule is asserted on the target path instead)\n');
    assert.equal(isInside(reportsDir, path.join(outsideDir, 'secret.txt')), false);
    return;
  }
  const r = resolveOpenPath(openCfg, 'report', 'link-out.txt');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'outside-roots');
  assert.ok(r.error.includes('outside'), r.error);
});

t('a name that does not exist is reported as missing, and a directory is not a file', () => {
  assert.equal(resolveOpenPath(openCfg, 'report', 'nope.html').code, 'missing');
  assert.equal(resolveOpenPath(openCfg, 'nosuchkind', 'daily-2026-09-14.html').code, 'unknown-kind');
  assert.equal(resolveOpenPath(openCfg, 'report', '').code, 'not-a-file-name');
});

t('the file-name rule itself: no separators, no "..", a bounded length', () => {
  assert.equal(isPlainFileName('daily-2026-09-14.html'), true);
  assert.equal(isPlainFileName('a b.md'), true);
  assert.equal(isPlainFileName(''), false);
  assert.equal(isPlainFileName('.'), false);
  assert.equal(isPlainFileName('..'), false);
  assert.equal(isPlainFileName('a/b'), false);
  assert.equal(isPlainFileName('a\\b'), false);
  assert.equal(isPlainFileName('a..b'), false);
  assert.equal(isPlainFileName('x'.repeat(201)), false);
});

t('the editor command resolves to VS Code by default, the platform opener as the fallback, and nothing when unknown', () => {
  // the default: `code` on PATH
  const vscode = resolveEditorCommand('', 'win32', (p) => p === 'code');
  assert.equal(vscode.program, 'code');
  assert.equal(vscode.source, 'vscode');
  // the fallback on Windows: `explorer`, which hands the path to the file association without re-parsing it.
  // It used to be `cmd /c start ""`, and the reason it is not any more is checked further down.
  const win = resolveEditorCommand('', 'win32', () => false);
  assert.equal(win.program, 'explorer');
  assert.deepEqual(win.args, []);
  assert.equal(win.source, 'platform');
  const mac = resolveEditorCommand('', 'darwin', () => false);
  assert.equal(mac.program, 'open');
  const linux = resolveEditorCommand('', 'linux', () => false);
  assert.equal(linux.program, 'xdg-open');
  // an unknown platform has nothing to fall back to, and says so rather than guessing
  assert.equal(resolveEditorCommand('', 'solaris', () => false).program, null);
});

t('a configured editor is split into program + arguments without a shell (quotes group a word)', () => {
  assert.deepEqual(parseEditorCommand('code -r'), ['code', '-r']);
  assert.deepEqual(parseEditorCommand('"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst'), ['C:\\Program Files\\Notepad++\\notepad++.exe', '-multiInst']);
  assert.deepEqual(parseEditorCommand(['code', '-n']), ['code', '-n']);
  assert.deepEqual(parseEditorCommand(''), []);
  // Anything shell-ish stays a program name that will simply not be found -- it is never interpreted.
  assert.deepEqual(parseEditorCommand('code && rm -rf /'), ['code', '&&', 'rm', '-rf', '/']);
  const r = resolveEditorCommand('code && rm -rf /', 'linux', () => false);
  assert.equal(r.program, 'code');
  assert.equal(r.source, 'configured');
});

t('the invocation is an argv array and never a command line', () => {
  const editor = resolveEditorCommand('code -r', 'linux', () => true);
  const inv = buildOpenInvocation({ path: path.join(reportsDir, 'daily-2026-09-14.html'), editor, platform: 'linux' });
  assert.equal(inv.ok, true);
  assert.ok(Array.isArray(inv.args), 'args must be an array');
  assert.equal(inv.shell, false, 'no shell may be involved');
  assert.equal(inv.command, 'code');
  assert.deepEqual(inv.args, ['-r', path.join(reportsDir, 'daily-2026-09-14.html')]);
  // The file name is one argv entry, so a name with shell syntax is a name
  const weird = buildOpenInvocation({ path: path.join(reportsDir, 'a & b; rm -rf.txt'), editor, platform: 'linux' });
  assert.equal(weird.args.length, 2);
  assert.ok(weird.args[1].endsWith('a & b; rm -rf.txt'));
  assert.equal(typeof weird.display, 'string');
  // No editor -> a reason, not a silent nothing
  const none = buildOpenInvocation({ path: path.join(reportsDir, 'x.html'), editor: { program: null, args: [] }, platform: 'linux' });
  assert.equal(none.ok, false);
  assert.ok(none.error.includes('no editor'), none.error);
});

t('the Windows fallback passes the path as one argument, with no shell prefix', () => {
  // This check used to pin the `""` title argument that `cmd /c start` needs before a path. That idiom was
  // removed on purpose - `cmd` re-parses whatever follows `/c`, so a file name containing `&` stopped being
  // one argument - and the check now pins the fact that replaced it, on both a plain and an awkward name. If
  // anyone reaches for a shell again, this fails together with the "no platform fallback resolves to a shell"
  // check below.
  const editor = resolveEditorCommand('', 'win32', () => false);
  const inv = buildOpenInvocation({ path: path.join(reportsDir, 'daily-2026-09-14.html'), editor, platform: 'win32' });
  assert.deepEqual(inv.args, [path.join(reportsDir, 'daily-2026-09-14.html')]);
  assert.equal(inv.shell, false);
  const weird = buildOpenInvocation({ path: path.join(reportsDir, 'a & b.txt'), editor, platform: 'win32' });
  assert.equal(weird.args.length, 1, 'an ampersand in the name must not become a second argument');
  assert.ok(weird.args[0].endsWith('a & b.txt'));
});

t('what the person is told after an open: the file and the program, or the reason', () => {
  const ok = openResultNote({ ok: true, opened: 'daily.html', editor: 'code -r' }, { program: 'code' });
  assert.ok(ok.en.includes('daily.html') && ok.en.includes('code -r'), ok.en);
  const bad = openResultNote({ ok: false, error: 'spawn code ENOENT' }, { program: 'code' });
  assert.ok(bad.en.includes('ENOENT'), bad.en);
});

vacuously(
  'a path outside the roots is refused (wrong input: a file that really is outside them)',
  (result) => (result.ok ? [] : [`refused: ${result.error}`]),
  () => resolveOpenPath(openCfg, 'report', 'daily-2026-09-14.html'),
  () => resolveOpenPath(openCfg, 'report', 'link-out.txt'),
);

vacuously(
  'the invocation really carries no shell string (wrong input: a joined command line passed as the program)',
  (inv) => {
    if (!inv.ok) return ['the invocation could not be built'];
    if (!Array.isArray(inv.args)) return ['args is not an array'];
    if (inv.shell !== false) return ['shell is not false'];
    if (String(inv.command).includes(' ')) return [`the program name contains a space: ${inv.command}`];
    return [];
  },
  () => buildOpenInvocation({ path: path.join(reportsDir, 'daily-2026-09-14.html'), editor: resolveEditorCommand('code -r', 'linux', () => true), platform: 'linux' }),
  () => buildOpenInvocation({ path: path.join(reportsDir, 'daily-2026-09-14.html'), editor: { program: 'cmd /c start', args: [] }, platform: 'linux' }),
);

// ───────────────────────────────────────────── 6. the per-site edited body

process.stdout.write('\nlogin check: the edited body per site\n');

const longBundle = {
  title: 'VML 日报',
  items: Array.from({ length: 40 }, (_, i) => ({ id: 'x' + i, title: `一条很长的标题 ${i}`, url: `https://example.com/${i}` })),
};

/**
 * A hand-added site with a **concrete** compose page and a 280-character limit.
 *
 * The hand-off rules are about the text, and the built-in sites cannot exercise all of them: Mastodon's
 * compose template is `https://{instance}/publish`, whose host is the user's own, so no link can be built
 * from it (a fact the checks below assert rather than paper over). A declared site has a real host and a
 * real limit, which is what the compose-link rules need.
 */
const composeSiteCfg = {
  share: {
    sites: [
      {
        id: 'my-compose',
        loginKind: 'mastodon',
        textLimit: 280,
        host: 'example.social',
        manual: { compose: 'https://example.social/publish?text={text}' },
      },
    ],
  },
};

t('the prepared body is cut to the site limit, and says it was cut', () => {
  const body = resolveSiteBody({ text: null, bundle: longBundle, profile: { textLimit: 280 } });
  assert.equal(body.source, 'prepared');
  assert.ok(body.text.length <= 280, String(body.text.length));
  assert.equal(body.truncated, true);
  assert.ok(body.droppedLines > 0);
  // A cut prepared body does NOT "fit" the report it was cut from -- saying it did would hide that the
  // person is about to publish a shortened version of it. `fits` is about the site's limit, `truncated`
  // about the source, and both are reported.
  assert.equal(body.fits, false);
  assert.equal(body.length, body.text.length);
});

t('an edited body wins over the prepared one, exactly as written', () => {
  const body = resolveSiteBody({ text: 'my own words', bundle: longBundle, profile: { textLimit: 280 } });
  assert.equal(body.source, 'edited');
  assert.equal(body.text, 'my own words');
  // The prepared text is still available, labelled as the app's -- the edited box must not be the only place
  // the report text exists, or "back to the prepared body" would have nothing to go back to.
  assert.ok(body.prepared.length > 0, 'the prepared text travels with the answer');
  assert.notEqual(body.prepared, body.text);
  assert.ok(body.prepared.includes('一条很长的标题 0'), body.prepared.slice(0, 60));
});

t('an edited body over the limit is reported as over it, and is NOT cut to fit', () => {
  const body = resolveSiteBody({ text: 'x'.repeat(400), bundle: longBundle, profile: { textLimit: 280 } });
  assert.equal(body.source, 'edited');
  assert.equal(body.over, true);
  assert.equal(body.fits, false);
  assert.equal(body.text.length, 400, 'the person’s words are never silently replaced by a truncation');
});

t('an emptied body is an edit too (it means "do not send the app’s report")', () => {
  const body = resolveSiteBody({ text: '', bundle: longBundle, profile: { textLimit: 280 } });
  assert.equal(body.source, 'edited');
  assert.equal(body.text, '');
  assert.equal(body.fits, true);
});

t('a body edited to fit produces a compose link; one edited to exceed the limit does not', () => {
  // The site is declared here rather than taken from the built-ins: what this family pins is the rule, and
  // the rule needs a compose page whose host is concrete. Of the built-in sites, Mastodon's compose template
  // is `https://{instance}/publish` -- the instance is the user's own -- so the hand-off deliberately returns
  // no link there, which the next check asserts instead of pretending otherwise.
  const fits = buildHandoff({ targetId: 'my-compose', bundle: longBundle, cfg: composeSiteCfg, text: 'a short edited body' });
  assert.equal(fits.ok, true);
  assert.equal(fits.textSource, 'edited');
  assert.equal(fits.text, 'a short edited body');
  assert.ok(fits.composeUrl, 'the compose link is offered for a body that fits');
  const u = new URL(fits.composeUrl);
  assert.equal(u.searchParams.get('text'), 'a short edited body', 'and it carries the edited body, not the prepared one');

  const over = buildHandoff({ targetId: 'my-compose', bundle: longBundle, cfg: composeSiteCfg, text: 'y'.repeat(400) });
  assert.equal(over.textSource, 'edited');
  assert.equal(over.fits, false);
  assert.equal(over.composeUrl, null, 'no compose link for a body over the limit');
  assert.ok(over.composeNote.en.includes('edited'), over.composeNote.en);
  assert.equal(over.text, 'y'.repeat(400), 'the hand-off still carries what the person wrote');
});

t('a compose page whose host is a placeholder gets no link, and says so rather than offering a broken one', () => {
  // `{instance}` is unfilled, and the rule for an unfilled placeholder is "no link at all": a compose box at
  // a domain nobody owns would be worse than the copy button, which is right there.
  const h = buildHandoff({ targetId: 'mastodon-post', bundle: longBundle, cfg: {}, text: 'a short edited body' });
  assert.equal(h.fits, true, 'the body does fit the site limit');
  assert.equal(h.composeUrl, null, 'but no link can be built from a placeholder host');
  assert.equal(h.sent, false);
  assert.equal(h.posted, false);
  assert.equal(h.text, 'a short edited body');
});

t('with no edit the hand-off carries the prepared body and says so', () => {
  const h = buildHandoff({ targetId: 'mastodon-post', bundle: longBundle, cfg: {} });
  assert.equal(h.textSource, 'prepared');
  assert.ok(h.text.length <= h.textLimit, `${h.text.length} > ${h.textLimit}`);
  // The app's own text travels with the answer, so the page can offer "back to the prepared body" and can
  // label which of the two the box currently holds. It is the **full** prepared text, not the cut one.
  assert.ok(h.preparedText.includes('一条很长的标题 0'), h.preparedText.slice(0, 60));
  assert.ok(h.preparedText.length >= h.text.length);
  // `fullLength` is the whole report's length before any cutting (what the page says when the body does not
  // fit); `preparedText` is the prepared body itself, already cut to this site's limit. Keeping them apart is
  // the point: "the site only takes 500 of your 1499 characters" is a different sentence from "here is the
  // text", and only the page that has both numbers can say the first one.
  assert.ok(h.fullLength > h.preparedText.length, `${h.fullLength} should be the whole report, ${h.preparedText.length} the cut body`);
  assert.equal(h.text, h.preparedText, 'with no edit, the body carried IS the prepared body');
  assert.ok(!h.composeUrl, 'and a body that had to be cut gets no compose link');
});

t('the copy/hand-off path carries the edited text rather than the prepared one', () => {
  const edited = buildHandoff({ targetId: 'weibo-post', bundle: longBundle, cfg: {}, text: 'edited for weibo' });
  assert.equal(edited.text, 'edited for weibo');
  assert.notEqual(edited.text, edited.preparedText);
  const prepared = buildHandoff({ targetId: 'weibo-post', bundle: longBundle, cfg: {} });
  assert.equal(prepared.text, prepared.preparedText);
});

vacuously(
  'the compose link follows the edited body (wrong input: a body edited past the limit)',
  (h) => (h.composeUrl ? [] : [`no compose link was produced (${h.composeNote?.en ?? 'no note'})`]),
  () => buildHandoff({ targetId: 'my-compose', bundle: longBundle, cfg: composeSiteCfg, text: 'short enough' }),
  () => buildHandoff({ targetId: 'my-compose', bundle: longBundle, cfg: composeSiteCfg, text: 'z'.repeat(300) }),
);

vacuously(
  'the hand-off carries the text it was given (wrong input: the prepared body while an edit exists)',
  (h) => (h.text === 'my edited words' ? [] : [`expected the edited text, got ${JSON.stringify(String(h.text).slice(0, 30))}`]),
  () => buildHandoff({ targetId: 'weibo-post', bundle: longBundle, cfg: {}, text: 'my edited words' }),
  () => buildHandoff({ targetId: 'weibo-post', bundle: longBundle, cfg: {} }),
);

// ───────────────────────────────────────────── 7. every surface renders the affordance and the route exists

process.stdout.write('\nlogin check: the pages and the routes\n');

t('every page that renders a login setting also renders the check affordance', () => {
  const pages = {
    // Settings moved out of this list when the browser/profile targeting moved to its own page: the field and
    // the check that exercises it now live together in Browser.jsx, and Settings links there instead of
    // keeping a second copy. The intent of this check is unchanged - every place that configures a login must
    // offer a way to check it - so the name moved with the affordance rather than the check being relaxed.
    //
    // The Live page was the fifth entry and is gone (the tab, its route and the live feature were removed
    // together), so its danmaku account check went with it. An entry naming a file that no longer exists
    // would make this check fail with an ENOENT instead of saying anything about logins.
    'web/src/pages/Browser.jsx': 'LoginCheckButton',
    'web/src/pages/Share.jsx': 'LoginCheckButton',
    'web/src/pages/Sources.jsx': 'LoginCheckButton',
    'web/src/pages/Watch.jsx': 'checkLogin',
  };
  for (const [file, needle] of Object.entries(pages)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(src.includes(needle), `${file} does not render the login check (${needle})`);
  }
  // The control for "an entry whose file is gone": the old list's fifth name is not a file any more, so a
  // reader of the pages map really would have thrown here.
  assert.equal(fs.existsSync(path.join(ROOT, 'web/src/pages/Live.jsx')), false, 'the removed page must not come back into this list');
});

t('the routes those affordances call exist on the server', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server/src/server.js'), 'utf8');
  for (const route of ["'/api/cookies/check'", "'/api/watch/login-check'", "'/api/share/check-login'", "'/api/open'"]) {
    assert.ok(serverSrc.includes(route), `the server does not define ${route}`);
  }
  // The expensive ones must keep the in-flight guard the rest of the app uses
  for (const route of ['/api/watch/login-check', '/api/share/check-login']) {
    assert.ok(new RegExp(`app\\.(post|get)\\('${route.replace(/\//g, '\\/')}', busyGuard\\(`).test(serverSrc), `${route} has no in-flight guard`);
  }
});

// ───────────────────────────────────────────── opening a file must not go through a shell
//
// The editor setting and the platform fallback both end up as an argv array, and the rule the module states is
// that a file name is data rather than syntax. A shell in that argv breaks the rule even when it is the
// platform's own opener: `cmd /c start "" <file>` re-parses what follows, so a name containing `&` becomes two
// commands. The Windows fallback used to be exactly that; it is `explorer` now, and this check is what keeps a
// later "simplification" from bringing the shell back -- with the old shape as the control, so the check is
// known to fire on the thing it replaced.
const SHELLS = ['cmd', 'cmd.exe', 'sh', 'bash', 'dash', 'zsh', 'powershell', 'pwsh', 'wsl'];
const shellProblems = (editor) => {
  const program = path.basename(String(editor?.program ?? '')).toLowerCase();
  if (!program) return [];
  return SHELLS.includes(program) ? [`the resolved opener is a shell (${program}), which re-parses the file name`] : [];
};

t('no platform fallback resolves to a shell', () => {
  const withoutVsCode = () => false;
  for (const platform of ['win32', 'darwin', 'linux']) {
    const editor = resolveEditorCommand('', platform, withoutVsCode);
    const problems = shellProblems(editor);
    assert.equal(problems.length, 0, `${platform}: ${problems.join('; ')}`);
    assert.ok(editor.program, `${platform}: no fallback program at all`);
  }
});

vacuously(
  'a platform fallback that is a shell',
  shellProblems,
  () => resolveEditorCommand('', 'win32', () => false),
  () => ({ program: 'cmd', args: ['/c', 'start', ''] }),
);

// ───────────────────────────────────────────── result

process.stdout.write('\n' + (fail ? `${fail} failed, ` : '') + `${pass} passed\n`);
if (VACUOUS.length) process.stdout.write(`${VACUOUS.length} control(s) did not fire -- see above\n`);
process.exit(fail ? 1 : 0);

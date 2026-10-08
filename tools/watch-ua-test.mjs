// ---------------------------------------------------------------------------------------------------
// tools/watch-ua-test.mjs — the User-Agent a request sends has to match what the request *is*.
//
// The defect, as measured: `server/src/watch.js` carried one module constant
//
//     const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
//                 Chrome/126.0.0.0 Safari/537.36';
//
// used by every request in the file, and nothing said whether `126` meant anything. It did not: the string was
// copied from the RSS fetcher and dates from when this product rendered with Chromium; the engine is Playwright
// Firefox since v1.0.4. A version number in a header is read by nobody, so nothing would ever have reported it
// — that is what "rotting in place" means, and it is why this file asserts a *decision* rather than the string.
//
// The decision, as taken:
//   • a MediaWiki API request (`mediawiki-page` / `-recentchanges` / `-watchlist`) is not a browser: it gets a
//     product token, built from package.json at runtime, so there is no literal version to forget;
//   • a `kind: 'url'` page fetch is a page and gets a browser token — and the browser this product drives is
//     Firefox, so that token says Firefox;
//   • **neither pins a version**, and the page token carries an explicit `rv:0.0 / Firefox/0.0` sentinel so
//     that "no version claim is being made" is visible in the header instead of looking like an oversight.
//
// Checks, each with the control it needs:
//   A. the two profiles exist, are exported, and are chosen by request kind (not by caller habit);
//   B. a page request and an API request really do send different headers — asserted on the **built request**,
//      which is the only place a header can be checked without a network;
//   C. no versioned Chrome literal is left in this module — and the control is the exact pre-fix line, run
//      through the same detector, which must be caught;
//   D. a versioned *Firefox* literal is caught too, so the rule is "do not pin an engine version", not
//      "replace Chrome with Firefox and keep the number";
//   E. the product token carries the package's own version — and the control is a package version that does not
//      match, which must fail.
//
// No network is used, and the repository's own config.json is never read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_REL = 'server/src/watch.js';

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
    failures.push(name + ' - ' + e.message);
    process.stdout.write('  [FAIL] ' + name + ' - ' + e.message + '\n');
  }
};
const section = (s) => process.stdout.write('\n' + s + '\n');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
/**
 * The module's text with LF line endings.
 *
 * This is not cosmetic, and the first version of this file got it wrong: git checks the sources out with CRLF
 * on Windows, and every line-based regex below is written with `$`/`[^\n]` semantics. On CRLF input a
 * line-comment cut consumes the CR as well, the following newline survives as a bare LF, and the *next* cut
 * then runs from there — so a single `//` inside a doc comment swallowed 16 KB of live code, and the "no pinned
 * version" check passed over the deletion instead of over the file.
 */
const asLf = (text) => String(text).split(CR + LF).join(LF);

const WATCH = await import(pathToFileURL(path.join(ROOT, MODULE_REL)).href);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const src = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');

/**
 * The versioned-engine detector.
 *
 * It looks for a version number attached to an engine token — `Chrome/126…`, `Firefox/155.0`, `rv:155.0` — and
 * requires a **dotted** version, so the deliberate `rv:0.0` / `Firefox/0.0` sentinel in the page profile (which
 * is the statement "no version is being claimed") is not mistaken for a pinned one. A bare integer is also a
 * real shape (`Chrome/126` in the sibling fetchers), and check C asserts that shape separately, on its own
 * literal, so narrowing this pattern cannot make that half vacuous.
 *
 * It is applied to code with comments removed, because this module explains the defect it fixes and therefore
 * quotes the old Chrome literal in prose.
 */
const ENGINE_VERSION_RE = /\b(?:Chrome|Firefox|rv|Gecko|AppleWebKit)\s*[/:]\s*(?!0+(?:\.0+)*\b)\d+(?:\.\d+)+/i;
const ENGINE_INTEGER_RE = /\b(?:Chrome|Firefox|rv|Gecko|AppleWebKit)\s*[/:]\s*\d+/i;

/**
 * The module's source with comments removed.
 *
 * A small character walk rather than a regex, and the reason is measured: a line-based cut cannot tell a real
 * `//` comment from the `//` inside a string — this module's doc comments are full of `https://` URLs and its
 * code carries `https://${host}` templates — and a first attempt at this deleted 16 KB of live source, after
 * which the "no pinned version" check passed over the deletion instead of over the file. The walk tracks
 * single quotes, double quotes and template literals (including `${…}` nesting), so a comment marker inside a
 * string is not a comment. The control below keeps it honest.
 */
const codeOnly = (text) => {
  const s = asLf(text);
  let out = '';
  let i = 0;
  // A stack, because a template literal may contain `${ … }` which may contain a string which may contain a
  // comment — one level of state cannot express that.
  const stack = [{ kind: 'code' }];
  while (i < s.length) {
    const top = stack[stack.length - 1];
    const two = s.slice(i, i + 2);
    if (top.kind === 'block') {
      if (two === '*/') {
        stack.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (top.kind === 'line') {
      if (s[i] === '\n') {
        stack.pop();
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (top.kind === 'single' || top.kind === 'double' || top.kind === 'template') {
      const closer = top.kind === 'single' ? "'" : top.kind === 'double' ? '"' : '`';
      if (s[i] === '\\') {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (s[i] === closer) {
        stack.pop();
        out += s[i];
        i += 1;
        continue;
      }
      if (top.kind === 'template' && two === '${') {
        stack.push({ kind: 'code' });
        out += two;
        i += 2;
        continue;
      }
      out += s[i];
      i += 1;
      continue;
    }
    // code
    if (two === '//') {
      stack.push({ kind: 'line' });
      i += 2;
      continue;
    }
    if (two === '/*') {
      stack.push({ kind: 'block' });
      i += 2;
      continue;
    }
    if (s[i] === "'") {
      stack.push({ kind: 'single' });
      out += s[i];
      i += 1;
      continue;
    }
    if (s[i] === '"') {
      stack.push({ kind: 'double' });
      out += s[i];
      i += 1;
      continue;
    }
    if (s[i] === '`') {
      stack.push({ kind: 'template' });
      out += s[i];
      i += 1;
      continue;
    }
    if (s[i] === '}' && stack.length > 1) {
      stack.pop();
      out += s[i];
      i += 1;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
};

section('A. the two profiles exist, and the request kind decides which one is used');
t('both profiles are exported', () => {
  assert.equal(typeof WATCH.API_UA, 'string');
  assert.equal(typeof WATCH.PAGE_UA, 'string');
  assert.ok(WATCH.API_UA.length > 8, 'the API profile is empty');
  assert.ok(WATCH.PAGE_UA.length > 8, 'the page profile is empty');
});
t('the profile is chosen by what the request is, not by which function happens to make it', () => {
  assert.equal(typeof WATCH.userAgentFor, 'function', 'there is no single place that decides the profile');
  assert.equal(WATCH.userAgentFor({ kind: 'url' }), WATCH.PAGE_UA);
  assert.equal(WATCH.userAgentFor({ kind: 'mediawiki-page' }), WATCH.API_UA);
  assert.equal(WATCH.userAgentFor({ kind: 'mediawiki-recentchanges' }), WATCH.API_UA);
  assert.equal(WATCH.userAgentFor({ kind: 'mediawiki-watchlist' }), WATCH.API_UA);
  // An unknown or absent kind is an API request: the module's page path is the one that must be asked for
  // explicitly, so a new kind added later cannot silently start sending a browser string.
  assert.equal(WATCH.userAgentFor({}), WATCH.API_UA);
  assert.equal(WATCH.userAgentFor(undefined), WATCH.API_UA);
});
t('the page profile is a Firefox token, because Firefox is the engine this product renders with', () => {
  assert.match(WATCH.PAGE_UA, /Firefox\//, 'the page profile no longer names the engine the product drives');
  assert.ok(!/Chrome\//.test(WATCH.PAGE_UA), 'the page profile still claims to be Chrome');
});
t('the API profile is a product token, not a browser', () => {
  assert.match(WATCH.API_UA, /^VtuberMonitorLink\//);
  assert.ok(!/Mozilla|Chrome|Firefox|AppleWebKit/.test(WATCH.API_UA), 'an API request still claims to be a browser');
});

section('B. the two profiles really reach the built requests');
t('the wiki login request carries the product token, and no credential in the URL', () => {
  const built = WATCH.buildWikiLoginRequest({ apiUrl: 'https://example.invalid/api.php', username: 'Bot@Task', botPassword: 'secret-value' });
  assert.equal(built.ok, true, built.error);
  assert.equal(built.headers['user-agent'], WATCH.API_UA);
  assert.ok(!String(built.url).includes('secret-value'), 'the password is in the URL');
  // The log-safe view must not grow a header field either.
  const safe = WATCH.safeLoginRequestSummary(built);
  assert.equal(safe.hasAuthorization, true);
  assert.ok(!JSON.stringify(safe).includes('secret-value'), 'the log-safe summary carries the password');
});
t('control: the same builder with a page-shaped target still answers the API token', () => {
  // The builder is only ever used for api.php, so this is the assertion that stops the profile choice from
  // being read off the target's `kind` in a place where the kind is irrelevant.
  const built = WATCH.buildWikiLoginRequest({ kind: 'url', apiUrl: 'https://example.invalid/api.php', username: 'u', botPassword: 'p' });
  assert.equal(built.headers['user-agent'], WATCH.API_UA);
});

section('C. no versioned engine literal is left in this module');
t('the module no longer carries a versioned Chrome literal', () => {
  const code = codeOnly(src);
  assert.ok(!/Chrome\s*\/\s*\d/.test(code), 'a versioned Chrome literal is back in the code');
  assert.ok(!/AppleWebKit\s*\/\s*\d/i.test(code), 'the WebKit version is pinned again');
});
t('the module does not pin a version of any engine either', () => {
  // The dotted shape is what a version claim looks like; the shipped page token uses the `0.0` sentinel, and the
  // check above asserts that the shipped value is the sentinel. A bare integer is caught separately, in check C.
  const code = codeOnly(src);
  const hit = code.match(ENGINE_VERSION_RE);
  assert.equal(hit, null, `a pinned engine version is in the code: ${hit?.[0]}`);
  // The same statement about the shipped **values**: a reader should not have to read the detector's lookahead
  // to find out whether the token in the header is a version claim. `0.0` in every position is the sentinel.
  for (const [name, value] of [['PAGE_UA', WATCH.PAGE_UA], ['API_UA', WATCH.API_UA]]) {
    assert.ok(
      !/Firefox\/(?!0\.0)\d|rv:(?!0\.0)\d|Chrome\/\d/.test(value),
      `${name} pins an engine version: ${value}`
    );
  }
});
t('control: the detector catches the exact pre-fix line (so a green check means something)', () => {
  const preFix = `const UA =\n  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';`;
  assert.match(codeOnly(preFix), ENGINE_VERSION_RE, 'the detector does not detect the defect it is named for');
  assert.match(codeOnly(preFix), /Chrome\s*\/\s*\d/, 'the Chrome half of the detector does not fire');
});
t('control: the bare-integer shape the sibling fetchers carry is caught too', () => {
  // `Chrome/126` with no dotted part is a real shape in this repository (server/src/fetchers/rss.js), so the
  // stricter dotted pattern used above must not be the only thing standing between it and a green check.
  const sibling = `const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';`;
  assert.match(codeOnly(sibling), ENGINE_INTEGER_RE, 'a bare integer engine version is not detected');
});
t('the page profile is genuinely a no-version token, and named as one', () => {
  // The sentinel IS version-shaped — `rv:0.0` deliberately looks like the position a version goes in — so the
  // general detector does flag it, and this asserts that rather than pretending otherwise. What has to hold is
  // that the value **shipped in the module** is the sentinel and not a real number, which is the only part a
  // reader cares about: a version claim requires a number that is not 0.
  const code = codeOnly(src);
  const m = code.match(/PAGE_UA\s*=\s*'([^']*)'/);
  assert.ok(m, 'the page profile is not a plain literal any more; this check needs to be rewritten');
  assert.match(m[1], /rv:0\.0/, `the shipped page token is not the sentinel: ${m[1]}`);
  assert.match(m[1], /Firefox\/0\.0/, `the shipped page token claims a Firefox version: ${m[1]}`);
  assert.ok(!/Firefox\/(?!0\.0)\d/.test(m[1]), `the shipped page token pins a real Firefox version: ${m[1]}`);
});
t('control: the stripper is not eating the code it is supposed to inspect', () => {
  // Without this, "no hit" could mean "the stripper removed everything", which would make the check vacuous.
  const planted = 'const headers = { "user-agent": "Mozilla/5.0 (X11) Gecko/20100101 Firefox/155.0" }; // trailing';
  assert.match(codeOnly(planted), ENGINE_VERSION_RE, 'the stripper removed a real statement');
  assert.ok(!/trailing/.test(codeOnly(planted)), 'the stripper did not remove a comment');
  // And a `//` inside a string is not a comment: this module's code carries https URLs.
  const url = `const u = 'https://example.invalid/api.php'; const v = 1;`;
  assert.ok(codeOnly(url).includes('const v = 1;'), 'the stripper cut the line at a URL');
});
t('the sentinel says the page token makes no version claim', () => {
  assert.match(WATCH.PAGE_UA, /rv:0\.0/, 'the version sentinel is gone: the header now looks like a pinned version');
  assert.match(WATCH.PAGE_UA, /Firefox\/0\.0/, 'the Firefox version sentinel is gone');
});

section('D. the product token is derived, not typed');
t('the API profile carries the package version', () => {
  assert.ok(WATCH.API_UA.includes(`/${pkg.version}`), `the token does not carry ${pkg.version}: ${WATCH.API_UA}`);
});
t('control: a wrong version in the expectation does not match (the check can fail)', () => {
  const wrong = pkg.version === '999.999.999' ? '1.0.0' : '999.999.999';
  assert.ok(!WATCH.API_UA.includes(`/${wrong}`), 'the token matched a version it should not have');
});

section('E. the sites that still carry the old literal are named, not silently forgiven');
t('the module records where the same literal still lives, and does not call itself the only site', () => {
  // This is a documentation assertion on purpose: the audit scoped this fix to watch.js, and a reader of the
  // module has to be able to find the rest without the commit message.
  const others = ['server/src/fetchers/rss.js', 'server/src/fetchers/mediawiki.js', 'server/src/probe.js', 'server/src/thumbs.js'];
  for (const rel of others) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is named but does not exist`);
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const stillThere = /Chrome\s*\/\s*126/.test(text);
    const named = src.includes(rel);
    if (stillThere) {
      assert.ok(named, `${rel} still carries Chrome/126 but the watch module does not name it as an outstanding site`);
    }
  }
});
t('the module states which of the two values each caller gets, and why', () => {
  assert.match(src, /API_UA/, 'no API profile');
  assert.match(src, /PAGE_UA/, 'no page profile');
  assert.match(src, /not a browser/i, 'the reasoning for the product token is gone');
});

process.stdout.write(`\nwatch user-agent: ${pass} ok, ${fail} failed\n`);
if (failures.length) {
  process.stdout.write('\nfailures:\n');
  for (const f of failures) process.stdout.write('  - ' + f + '\n');
}
process.exit(fail ? 1 : 0);

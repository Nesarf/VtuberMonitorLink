// thumb-cache-test.mjs - the Sources page must not re-ask for thumbnails it already has.
//
// The reason this has its own module and its own test: the page used to fetch up to fourteen thumbnails on
// every visit and again whenever its data object was replaced, which the request log recorded as bursts of
// 14 and 28. A cache that is three lines long cannot be verified by reading the page.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadThumb, cachedThumb, clearThumbCache, thumbKey } from '../web/src/thumb-cache.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
// The checks below are asynchronous (they await the cache), so the runner has to await them: the
// synchronous `t(name, fn)` used by the other test files would have let every one of them run as a
// floating promise, which is a check that reports ok without testing anything. Each check also starts
// from an empty cache, so one cannot be satisfied by what another left behind.
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const source = { id: 'news-ann', url: 'https://www.animenewsnetwork.com/' };
const counts = () => ({ calls: 0 });

process.stdout.write('\nthumb cache: ask once, keep the answer\n');

t('a second ask for the same source never reaches the fetcher', async () => {
  clearThumbCache();
  const c = counts();
  const fetchMeta = async () => {
    c.calls++;
    return { ok: true, image: 'blob:one' };
  };
  const first = await loadThumb(source, fetchMeta);
  const second = await loadThumb(source, fetchMeta);
  const third = await loadThumb({ ...source }, fetchMeta); // a fresh object, the same source
  assert.equal(first, 'blob:one');
  assert.equal(second, 'blob:one');
  assert.equal(third, 'blob:one');
  assert.equal(c.calls, 1, `the fetcher was called ${c.calls} times`);
  assert.equal(cachedThumb(source), 'blob:one');
});

t('two asks at the same time are one question', async () => {
  clearThumbCache();
  const c = counts();
  const fetchMeta = async () => {
    c.calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, image: 'blob:two' };
  };
  const [a, b] = await Promise.all([loadThumb(source, fetchMeta), loadThumb(source, fetchMeta)]);
  assert.equal(a, 'blob:two');
  assert.equal(b, 'blob:two');
  assert.equal(c.calls, 1, `two simultaneous asks became ${c.calls} fetches`);
});

t('"there is nothing there" is an answer, and is kept', async () => {
  clearThumbCache();
  const c = counts();
  const fetchMeta = async () => {
    c.calls++;
    return { ok: true, image: null };
  };
  assert.equal(await loadThumb(source, fetchMeta), '');
  assert.equal(await loadThumb(source, fetchMeta), '');
  assert.equal(c.calls, 1, 'a source with no thumbnail should not be asked again');
  assert.equal(cachedThumb(source), '');
});

t('a failure is not kept, so a host that is down now can answer later', async () => {
  clearThumbCache();
  let calls = 0;
  const fetchMeta = async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return { ok: true, image: 'blob:three' };
  };
  assert.equal(await loadThumb(source, fetchMeta), '');
  assert.equal(await loadThumb(source, fetchMeta), 'blob:three');
  assert.equal(calls, 2, 'the first failure should not have been cached');
});

t('an unsuccessful answer is not treated as an image', async () => {
  clearThumbCache();
  const fetchMeta = async () => ({ ok: false, error: 'no' });
  assert.equal(await loadThumb(source, fetchMeta), '');
});

t('different sources are different questions', () => {
  clearThumbCache();
  assert.notEqual(thumbKey({ id: 'a', url: 'https://a/' }), thumbKey({ id: 'b', url: 'https://b/' }));
  // The same id at a different address is a different question too: the address is what the image comes from.
  assert.notEqual(thumbKey({ id: 'a', url: 'https://a/' }), thumbKey({ id: 'a', url: 'https://a/x' }));
});

t('every check above is really asynchronous, and the module is what the page uses', async () => {
  // The claims above depend on `await` actually running; if loadThumb returned a cached value
  // synchronously the counts would still match while nothing was tested. And the page must go through
  // the module: a raw fetch loop in the page is exactly the shape this cache was written to remove.
  let resolvedSynchronously = true;
  const p = loadThumb(source, async () => ({ ok: true, image: 'x' })).then(() => {
    resolvedSynchronously = false;
  });
  assert.equal(resolvedSynchronously, true, 'the first ask must be a real promise');
  await p;

  const page = fs.readFileSync(path.join(ROOT, 'web/src/pages/Sources.jsx'), 'utf8');
  assert.ok(/from '\.\.\/thumb-cache\.js'/.test(page), 'the page should import the cache');
  assert.ok(/loadThumb\(/.test(page), 'the page should ask through loadThumb');
  assert.ok(!/api\.thumbMeta\(/.test(page), 'the page must not call the API directly any more');
});

for (const { name, fn } of tests) {
  clearThumbCache();
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

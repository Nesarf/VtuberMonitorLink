// wbi-test.mjs — self-test for bilibili WBI signing
//
// The consequences of a wrong signature are subtle: the endpoint reliably returns -352, which
// looks like "risk control" or "a login is required", so you go and add a login session, add a
// proxy, and after a long struggle it turns out w_rid was computed wrong.
// So the three parts of the algorithm are pinned down here one by one:
//   1) sample key -> mixin key (the permutation table must be a valid permutation of 0..63)
//   2) parameter sort + filter !'()* + md5 -> w_rid
//   3) wts takes part in the signature, changing one parameter always changes w_rid, and
//      parameter order does not affect the result
//
// By default it is **offline**; with --live it really hits nav once plus a signed getDanmuInfo,
// to confirm the signature is accepted by the server (whether -352 disappears).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  KEY_TTL_MS,
  MIXIN_KEY_ENC_TAB,
  SIGN_ERROR_CODES,
  clearWbiCache,
  getWbiKeys,
  keyFromUrl,
  mixinKey,
  signQuery,
  signUrl,
} from '../server/src/wbi.js';

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

process.stdout.write('\nwbi: permutation table and mixin key\n');
t('the permutation table is a valid permutation of 0..63 (one wrong number makes everything wrong)', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
  const sorted = [...MIXIN_KEY_ENC_TAB].sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: 64 }, (_, i) => i));
});

t('mixin key = the first 32 characters of the concatenation reordered by the table', () => {
  const img = 'a'.repeat(32);
  const sub = 'b'.repeat(32);
  const raw = img + sub;
  const key = mixinKey(img, sub);
  assert.equal(key.length, 32);
  const expected = MIXIN_KEY_ENC_TAB.slice(0, 32)
    .map((i) => raw[i])
    .join('');
  assert.equal(key, expected);
  // Pin the positions: slot 0 comes from raw[46], slot 1 comes from raw[47] (the first two slots are 46/47)
  assert.equal(key[0], raw[46]);
  assert.equal(key[1], raw[47]);
});

t('a too-short key returns an empty string (rather than a truncated mess)', () => {
  assert.equal(mixinKey('abc', 'def'), '');
});

t('taking the key from a URL: only a 32-hex-character filename counts', () => {
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), '7cd084941338484aae1ad9425b84077c');
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.jpg'), '7cd084941338484aae1ad9425b84077c');
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/not-a-key.png'), '');
  assert.equal(keyFromUrl(''), '');
  assert.equal(keyFromUrl(null), '');
});

process.stdout.write('\nwbi: signing\n');
const MIX = 'ea1db124af3c7062474693fa704f4ff8';

t('w_rid is 32 hex characters, and wts takes part in the signature', () => {
  const a = signQuery({ room_id: 123, wts: 1700000000 }, MIX, 1700000000);
  assert.match(a.w_rid, /^[0-9a-f]{32}$/);
  // Hand-recompute: parameters sorted by key -> filtered -> mixin appended -> md5
  const manual = crypto
    .createHash('md5')
    .update(`room_id=123&wts=1700000000${MIX}`)
    .digest('hex');
  assert.equal(a.w_rid, manual);
});

t('parameter order does not affect the result (sorted by parameter name)', () => {
  const a = signQuery({ b: '2', a: '1', c: '3' }, MIX, 1700000000);
  const b = signQuery({ c: '3', a: '1', b: '2' }, MIX, 1700000000);
  assert.equal(a.w_rid, b.w_rid);
  assert.ok(a.query.startsWith('a=1&b=2&c=3&wts='), a.query);
});

t('changing one parameter value always changes w_rid', () => {
  const a = signQuery({ room_id: 1 }, MIX, 1700000000);
  const b = signQuery({ room_id: 2 }, MIX, 1700000000);
  assert.notEqual(a.w_rid, b.w_rid);
});

t("the filtered characters are exactly these five !'()* (it is not stripping all punctuation)", () => {
  const a = signQuery({ q: "a!b'c(d)e*f" }, MIX, 1700000000);
  const manual = crypto.createHash('md5').update(`q=abcdef&wts=1700000000${MIX}`).digest('hex');
  assert.equal(a.w_rid, manual);
  // Other punctuation must survive (it takes part in the signature after URL encoding)
  const b = signQuery({ q: 'a-b_c.d~e' }, MIX, 1700000000);
  assert.ok(decodeURIComponent(b.query).includes('a-b_c.d~e'), b.query);
});

t('values are URL-encoded before signing (space / CJK / slash)', () => {
  const q = signQuery({ k: '中文 值/带斜杠' }, MIX, 1700000000);
  assert.ok(q.query.includes(encodeURIComponent('中文 值/带斜杠')), q.query);
  assert.ok(!q.query.includes(' '), 'no bare space may remain');
});

t('wts can be given explicitly (handy for reproduction and self-checks)', () => {
  const a = signQuery({ x: 1 }, MIX, 111);
  const b = signQuery({ x: 1 }, MIX, 111);
  assert.equal(a.query, b.query);
  assert.ok(a.query.includes('wts=111'));
});

t('signUrl keeps the existing query and appends the signature', () => {
  const signed = signUrl('https://api.bilibili.com/x/foo?a=1&b=2', MIX, 1700000000);
  const u = new URL(signed);
  assert.equal(u.searchParams.get('a'), '1');
  assert.equal(u.searchParams.get('b'), '2');
  assert.ok(u.searchParams.get('w_rid'));
  assert.equal(u.searchParams.get('wts'), '1700000000');
});

t('the signature-error code set covers -352 / -403 / -412', () => {
  assert.ok(SIGN_ERROR_CODES.has(-352));
  assert.ok(SIGN_ERROR_CODES.has(-403));
  assert.ok(SIGN_ERROR_CODES.has(-412));
  assert.ok(!SIGN_ERROR_CODES.has(0));
});

t('the key cache TTL is on the order of hours (the key rotates daily, but it need not be fetched on every request)', () => {
  assert.ok(KEY_TTL_MS >= 3600_000 && KEY_TTL_MS <= 24 * 3600_000);
});

t('clearing the cache is idempotent (calling it twice must not throw)', () => {
  clearWbiCache();
  assert.doesNotThrow(() => clearWbiCache());
});

// ───────────────────────────────────────────── live verification (optional)

if (process.argv.includes('--live')) {
  process.stdout.write('\nwbi: live verification (really hits bilibili)\n');
  const cfg = { proxy: { enabled: false } };
  await ta('the WBI key can be fetched (anonymous is enough, no login needed)', async () => {
    const k = await getWbiKeys(cfg, { force: true });
    assert.equal(k.ok, true, k.error);
    assert.equal(k.mixin.length, 32);
    process.stdout.write(`         img=${k.img.slice(0, 10)}… sub=${k.sub.slice(0, 10)}…\n`);
  });

  await ta('a signed getDanmuInfo no longer returns -352 (risk control)', async () => {
    const { wbiFetch } = await import('../server/src/wbi.js');
    const r = await wbiFetch(cfg, 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo', {
      params: { id: 22637261, type: 0 },
    });
    const code = Number(r.json?.code);
    process.stdout.write(`         code=${code} message=${r.json?.message ?? ''} retried=${!!r.retried}\n`);
    // Without a login the token may be missing, but it **must no longer be -352**: the signature
    // being accepted is the point
    assert.notEqual(code, -352, 'still -352: the signature is not taking effect');
    assert.ok(Number.isFinite(code), 'a definite business code should come back');
  });
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

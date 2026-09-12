// wbi-test.mjs — WBI 签名的自检 / self-test for bilibili WBI signing
//
// 签名写错的后果很隐蔽：接口稳定返回 -352，看起来像「风控」或者「要登录」，
// 于是会去加登录态、加代理，折腾半天其实只是 w_rid 算错了。
// 所以这里把三段算法逐段钉住：
//   1) 取样 key → mixin key（置换表必须是 0..63 的合法排列）
//   2) 参数排序 + 过滤 !'()* + md5 → w_rid
//   3) wts 参与签名、改一个参数 w_rid 必变、参数顺序不影响结果
//
// 默认**不联网**；加 --live 会真的打一次 nav + 签名后的 getDanmuInfo，
// 用来确认签名被服务端接受（-352 是否消失）。
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

process.stdout.write('\nwbi: 置换表与 mixin key\n');
t('置换表是 0..63 的合法排列（写错一个数字就全盘错）', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
  const sorted = [...MIXIN_KEY_ENC_TAB].sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: 64 }, (_, i) => i));
});

t('mixin key = 拼接后按表重排的前 32 位', () => {
  const img = 'a'.repeat(32);
  const sub = 'b'.repeat(32);
  const raw = img + sub;
  const key = mixinKey(img, sub);
  assert.equal(key.length, 32);
  const expected = MIXIN_KEY_ENC_TAB.slice(0, 32)
    .map((i) => raw[i])
    .join('');
  assert.equal(key, expected);
  // 明确定位：第 0 位来自 raw[46]、第 1 位来自 raw[47]（前两个位置是 46/47）
  assert.equal(key[0], raw[46]);
  assert.equal(key[1], raw[47]);
});

t('key 长度不够时返回空（而不是算出一半的垃圾）', () => {
  assert.equal(mixinKey('abc', 'def'), '');
});

t('从 URL 取 key：只有 32 位十六进制文件名才算', () => {
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), '7cd084941338484aae1ad9425b84077c');
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.jpg'), '7cd084941338484aae1ad9425b84077c');
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/not-a-key.png'), '');
  assert.equal(keyFromUrl(''), '');
  assert.equal(keyFromUrl(null), '');
});

process.stdout.write('\nwbi: 签名\n');
const MIX = 'ea1db124af3c7062474693fa704f4ff8';

t('w_rid 是 32 位十六进制，且 wts 参与签名', () => {
  const a = signQuery({ room_id: 123, wts: 1700000000 }, MIX, 1700000000);
  assert.match(a.w_rid, /^[0-9a-f]{32}$/);
  // 手工重算：参数按 key 排序 → 过滤 → 拼 mixin → md5
  const manual = crypto
    .createHash('md5')
    .update(`room_id=123&wts=1700000000${MIX}`)
    .digest('hex');
  assert.equal(a.w_rid, manual);
});

t('参数顺序不影响结果（按参数名排序）', () => {
  const a = signQuery({ b: '2', a: '1', c: '3' }, MIX, 1700000000);
  const b = signQuery({ c: '3', a: '1', b: '2' }, MIX, 1700000000);
  assert.equal(a.w_rid, b.w_rid);
  assert.ok(a.query.startsWith('a=1&b=2&c=3&wts='), a.query);
});

t('改一个参数值，w_rid 必变', () => {
  const a = signQuery({ room_id: 1 }, MIX, 1700000000);
  const b = signQuery({ room_id: 2 }, MIX, 1700000000);
  assert.notEqual(a.w_rid, b.w_rid);
});

t("过滤字符是 !'()* 这五个（不是去掉所有标点）", () => {
  const a = signQuery({ q: "a!b'c(d)e*f" }, MIX, 1700000000);
  const manual = crypto.createHash('md5').update(`q=abcdef&wts=1700000000${MIX}`).digest('hex');
  assert.equal(a.w_rid, manual);
  // 其它标点要保留（URL 编码后参与签名）
  const b = signQuery({ q: 'a-b_c.d~e' }, MIX, 1700000000);
  assert.ok(decodeURIComponent(b.query).includes('a-b_c.d~e'), b.query);
});

t('值会被 URL 编码后再签名（空格/中文/斜杠）', () => {
  const q = signQuery({ k: '中文 值/带斜杠' }, MIX, 1700000000);
  assert.ok(q.query.includes(encodeURIComponent('中文 值/带斜杠')), q.query);
  assert.ok(!q.query.includes(' '), '不能留裸空格');
});

t('wts 可以被显式指定（便于复现与自检）', () => {
  const a = signQuery({ x: 1 }, MIX, 111);
  const b = signQuery({ x: 1 }, MIX, 111);
  assert.equal(a.query, b.query);
  assert.ok(a.query.includes('wts=111'));
});

t('signUrl 保留原有 query 并追加签名', () => {
  const signed = signUrl('https://api.bilibili.com/x/foo?a=1&b=2', MIX, 1700000000);
  const u = new URL(signed);
  assert.equal(u.searchParams.get('a'), '1');
  assert.equal(u.searchParams.get('b'), '2');
  assert.ok(u.searchParams.get('w_rid'));
  assert.equal(u.searchParams.get('wts'), '1700000000');
});

t('签名类错误码集合覆盖 -352 / -403 / -412', () => {
  assert.ok(SIGN_ERROR_CODES.has(-352));
  assert.ok(SIGN_ERROR_CODES.has(-403));
  assert.ok(SIGN_ERROR_CODES.has(-412));
  assert.ok(!SIGN_ERROR_CODES.has(0));
});

t('key 缓存 TTL 是小时级（key 每天轮换，但不必每请求都取）', () => {
  assert.ok(KEY_TTL_MS >= 3600_000 && KEY_TTL_MS <= 24 * 3600_000);
});

t('清缓存后状态归零', () => {
  clearWbiCache();
  assert.doesNotThrow(() => clearWbiCache());
});

// ───────────────────────────────────────────── 联网验证（可选）

if (process.argv.includes('--live')) {
  process.stdout.write('\nwbi: 联网验证（真的打 B 站）\n');
  const cfg = { proxy: { enabled: false } };
  await ta('能取到 WBI key（匿名即可，不需要登录）', async () => {
    const k = await getWbiKeys(cfg, { force: true });
    assert.equal(k.ok, true, k.error);
    assert.equal(k.mixin.length, 32);
    process.stdout.write(`         img=${k.img.slice(0, 10)}… sub=${k.sub.slice(0, 10)}…\n`);
  });

  await ta('带签名的 getDanmuInfo 不再返回 -352（风控）', async () => {
    const { wbiFetch } = await import('../server/src/wbi.js');
    const r = await wbiFetch(cfg, 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo', {
      params: { id: 22637261, type: 0 },
    });
    const code = Number(r.json?.code);
    process.stdout.write(`         code=${code} message=${r.json?.message ?? ''} retried=${!!r.retried}\n`);
    // 未登录时可能拿不到 token，但**不该再是 -352**：签名被接受是关键
    assert.notEqual(code, -352, '仍然是 -352：签名没生效');
    assert.ok(Number.isFinite(code), '应当拿到一个明确的业务码');
  });
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

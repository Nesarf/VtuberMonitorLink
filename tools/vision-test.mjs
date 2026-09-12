// vision-test.mjs — 图片打标的自检 / self-test for image tagging
//
// 用本地假视觉模型做**端到端**验证（不花 Key、也不把图片发出去）：
//   · 请求真的带上了 image_url（否则「打标」是假的）
//   · 缓存按图片 URL 生效：同一张图第二次不再调用模型
//   · 解析器对不老实的回复要宽容（JSON 外面裹解释 / 带围栏 / 完全不是 JSON）
//   · 失败要被记录成 failed（且标记 ok:false 以便下次重试），而不是整批崩掉
//   · 未启用时**一张图都不发**（隐私开关必须是硬闸门）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_KINDS,
  applyVisionTags,
  imageKey,
  isTransportError,
  loadVisionCache,
  parseTags,
  tagItems,
  visionReady,
  visionStats,
} from '../server/src/vision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-vision-'));
const cfgFor = (port, extra = {}) => ({
  paths: { feedsDir: tmp, logsDir: tmp },
  proxy: { enabled: false },
  llm: { activeId: 'mock', providers: [{ id: 'mock', name: 'Mock Vision', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', model: 'mock-vision-1' }] },
  vision: { enabled: true, concurrency: 2, ...extra },
});

process.stdout.write('\nvision: 解析器的宽容度\n');
t('标准 JSON', () => {
  const r = parseTags('{"kind":"poster","tags":["海报","活动"],"text":"3D披露","people":[],"confidence":0.8}');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'poster');
  assert.deepEqual(r.tags, ['海报', '活动']);
  assert.equal(r.confidence, 0.8);
});

t('JSON 外面裹解释 + ``` 围栏', () => {
  const r = parseTags('好的：\n```json\n{"kind":"meme","tags":["梗图"]}\n```\n还需要别的吗？');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'meme');
});

t('裸 JSON 前后有文字（取第一个平衡的花括号）', () => {
  const r = parseTags('分析结果 {"kind":"photo","tags":["合影"]} 完毕');
  assert.equal(r.ok, true);
  assert.deepEqual(r.tags, ['合影']);
});

t('值里带花括号的字符串不会把括号配对搞乱', () => {
  const r = parseTags('{"kind":"poster","text":"显示 { 和 } 两个符号","tags":["海报"]}');
  assert.equal(r.ok, true);
  assert.equal(r.text, '显示 { 和 } 两个符号');
});

t('tags 写成逗号串也认（模型经常这么干）', () => {
  const r = parseTags('{"kind":"illustration","tags":"插画, 人物、粉色"}');
  assert.deepEqual(r.tags, ['插画', '人物', '粉色']);
});

t('未知 kind 落到 other，confidence 越界会被夹住', () => {
  assert.equal(parseTags('{"kind":"乱写","tags":[]}').kind, 'other');
  assert.equal(parseTags('{"kind":"photo","confidence":9}').confidence, 1);
  assert.equal(parseTags('{"kind":"photo","confidence":"0.5"}').confidence, 0.5);
  assert.equal(parseTags('{"kind":"photo"}').confidence, null);
});

t('完全不是 JSON / 空回复 → 明确失败，不抛异常', () => {
  assert.equal(parseTags('抱歉，我看不了图。').ok, false);
  assert.equal(parseTags('').ok, false);
  assert.equal(parseTags(null).ok, false);
});

t('allowed kinds 是固定集合（界面按它显示图标）', () => {
  assert.ok(IMAGE_KINDS.includes('poster') && IMAGE_KINDS.includes('meme') && IMAGE_KINDS.includes('other'));
});

t('缓存键忽略查询串（同一张图带不同签名参数仍是同一张）', () => {
  assert.equal(imageKey('https://i0.hdslb.com/a.jpg?sign=abc'), imageKey('https://i0.hdslb.com/a.jpg?sign=xyz'));
  assert.notEqual(imageKey('https://i0.hdslb.com/a.jpg'), imageKey('https://i0.hdslb.com/b.jpg'));
  assert.equal(imageKey(''), '');
});

process.stdout.write('\nvision: 隐私开关\n');
t('未启用时一张图都不发（明确拒绝而不是偷偷发）', async () => {
  const r = await tagItems(cfgFor(1, { enabled: false }), { items: [{ id: 'x', images: ['https://example.com/a.jpg'] }] });
  assert.equal(r.ok, false);
  assert.equal(r.tagged, 0);
  assert.ok(r.error.includes('未启用'), r.error);
});

t('没有 API Key 时拒绝（不会拿空 key 去调）', () => {
  const cfg = cfgFor(1);
  cfg.llm.providers[0].apiKey = '';
  const r = visionReady(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('API Key'), r.reason);
});

process.stdout.write('\nvision: 传输层错误 vs 业务错误（决定要不要重试）\n');
t('传输层错误认得出来（连接被掐断、socket 死掉…）', () => {
  for (const msg of [
    'fetch failed(ECONNRESET)',
    'socket hang up',
    'other side closed',
    'fetch failed',
    'ECONNREFUSED',
    'UND_ERR_SOCKET',
  ]) {
    assert.equal(isTransportError(msg), true, msg);
  }
});
t('业务错误不当成传输层错误（重试也不会有不同结果）', () => {
  for (const msg of [
    'HTTP 401: {"error":"invalid api key"}',
    'HTTP 500: {"error":"mock flaky failure"}',
    '回复里没有可解析的 JSON',
    '空回复',
    '',
    null,
  ]) {
    assert.equal(isTransportError(msg), false, String(msg));
  }
});

process.stdout.write('\nvision: 端到端（本地假视觉模型）\n');
const PORT = 43291;
const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(PORT)], { stdio: 'ignore' });
await sleep(900);

const items = [
  { id: 'v1', title: '嘉然 3D模型 公开', images: ['https://example.com/3d-model.jpg'], keywords: [] },
  { id: 'v2', title: '周边实物图', images: ['https://example.com/merch-goods.jpg'], keywords: [] },
  { id: 'v3', title: '活动海报', images: ['https://example.com/poster-banner.jpg'], keywords: [] },
  { id: 'v4', title: '没有配图', images: [], keywords: [] },
];

await ta('打标成功，并按图内容给出不同 kind', async () => {
  const cfg = cfgFor(PORT);
  const r = await tagItems(cfg, { items });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tagged, 3, JSON.stringify(r));
  const cache = loadVisionCache(cfg);
  const keys = Object.keys(cache);
  assert.equal(keys.length, 3);
  const kinds = keys.map((k) => cache[k].kind).sort();
  assert.deepEqual(kinds, ['merch', 'poster', 'screenshot']);
});

await ta('缓存生效：第二次一张图都不再调模型', async () => {
  const cfg = cfgFor(PORT);
  const r = await tagItems(cfg, { items });
  assert.equal(r.tagged, 0, '不应重复打标');
  assert.equal(r.cached, 3, JSON.stringify(r));
});

await ta('force 会忽略缓存重新打标', async () => {
  const cfg = cfgFor(PORT);
  const r = await tagItems(cfg, { items, force: true, limit: 1 });
  assert.equal(r.tagged, 1, JSON.stringify(r));
});

await ta('标签贴回条目，并进入可检索的关键词', async () => {
  const cfg = cfgFor(PORT);
  const cache = loadVisionCache(cfg);
  const { items: merged, tagCount } = applyVisionTags(items, cache);
  const v1 = merged.find((i) => i.id === 'v1');
  assert.deepEqual(v1.imageTags, ['3D模型', '截图']);
  assert.deepEqual(v1.imageKinds, ['screenshot']);
  assert.ok(v1.keywords.includes('3D模型'), '图片标签应进关键词，才能被检索命中');
  assert.deepEqual(merged.find((i) => i.id === 'v4').imageTags, undefined, '没配图的条目不该被改动');
  assert.ok(Object.keys(tagCount).length >= 3);
});

await ta('统计能看到标签分布与失败数', async () => {
  const s = visionStats(cfgFor(PORT));
  assert.equal(s.enabled, true);
  assert.ok(s.tagged >= 3);
  assert.ok(s.kinds.screenshot >= 1);
  assert.ok(s.topTags.length >= 3);
});

await ta('limit 限制本次处理张数（不一次打光）', async () => {
  const cfg = cfgFor(PORT);
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, title: 'x', images: [`https://example.com/new-${i}.jpg`] }));
  const r = await tagItems(cfg, { items: many, limit: 2 });
  assert.equal(r.total, 2, JSON.stringify(r));
  assert.equal(r.tagged, 2);
});

mock.kill();

// 不同模式的解析宽容度
const runMode = async (mode, port) => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(port), '--mode', mode], { stdio: 'ignore' });
  await sleep(900);
  const cfg = cfgFor(port);
  const r = await tagItems(cfg, { items: [{ id: 'x', title: 't', images: [`https://example.com/${mode}-1.jpg`] }] });
  m.kill();
  return r;
};

await ta('prose 模式（JSON 外面裹一段话）也能解析', async () => {
  const r = await runMode('prose', 43292);
  assert.equal(r.tagged, 1, JSON.stringify(r));
});

await ta('bad 模式（完全不是 JSON）被记为 failed，且标记 ok:false 以便重试', async () => {
  const r = await runMode('bad', 43293);
  assert.equal(r.tagged, 0);
  assert.equal(r.failed, 1, JSON.stringify(r));
  // 必须按这张图的键去查 —— 缓存文件是共享的，取「第一条」会拿到别的测试留下的条目（踩过）
  const cache = loadVisionCache(cfgFor(43293));
  const entry = cache[imageKey('https://example.com/bad-1.jpg')];
  assert.ok(entry, '这张图应当有记录');
  assert.equal(entry.ok, false);
  assert.ok(entry.error);
});

await ta('flaky 模式：失败的不会被缓存成成功', async () => {
  const r = await runMode('flaky', 43294);
  // 第一次请求是 500 → 应当 failed
  assert.equal(r.tagged, 0, JSON.stringify(r));
  assert.equal(r.failed, 1);
});

// 传输层失败（连接被掐断）→ 重试一次；HTTP 500 属于另一类，不重试。
// 这条是拿真实 socket 掐断跑的，不是打桩：mock 的 `drop` 模式第一次请求直接 destroy。
await ta('drop 模式：传输层失败会重试一次，并如实记下 retried', async () => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(43295), '--mode', 'drop'], { stdio: 'ignore' });
  await sleep(900);
  try {
    const r = await tagItems(cfgFor(43295), { items: [{ id: 'd', title: 't', images: ['https://example.com/drop-1.jpg'] }] });
    assert.equal(r.tagged, 1, '掐断后重试应当成功：' + JSON.stringify(r));
    assert.equal(r.retried, 1, '要如实记下发生过一次重试：' + JSON.stringify(r));
    assert.equal(r.failed, 0);
  } finally {
    m.kill();
  }
});

await ta('HTTP 失败不重试（重试也不会有不同结果）', async () => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(43296), '--mode', 'flaky'], { stdio: 'ignore' });
  await sleep(900);
  try {
    const r = await tagItems(cfgFor(43296), { items: [{ id: 'f', title: 't', images: ['https://example.com/500-1.jpg'] }] });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.retried, 0, '500 不该被当成传输层错误重试：' + JSON.stringify(r));
  } finally {
    m.kill();
  }
});

await ta('失败会带上原因（不是只有一个数字）', async () => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(43297), '--mode', 'bad'], { stdio: 'ignore' });
  await sleep(900);
  try {
    const r = await tagItems(cfgFor(43297), { items: [{ id: 'e', title: 't', images: ['https://example.com/reason-1.jpg'] }] });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.ok(Array.isArray(r.errors) && r.errors.length === 1, '要带出失败原因：' + JSON.stringify(r));
    assert.equal(r.errors[0].url, 'https://example.com/reason-1.jpg');
    assert.ok(r.errors[0].error, '原因不能是空串');
  } finally {
    m.kill();
  }
});

fs.rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

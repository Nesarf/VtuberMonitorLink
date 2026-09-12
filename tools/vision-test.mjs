// vision-test.mjs — self-test for image tagging
//
// End-to-end verification against a local fake vision model (costs no API key and never sends an image out):
//   · the request really carries image_url (otherwise the "tagging" is fake)
//   · the cache works per image URL: the same image does not call the model a second time
//   · the parser has to be forgiving with dishonest replies (JSON wrapped in prose / inside fences / not JSON at all)
//   · a failure is recorded as failed (and flagged ok:false so it is retried next time), rather than crashing the whole batch
//   · when disabled **not a single image is sent** (the privacy switch has to be a hard gate)
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

process.stdout.write('\nvision: parser tolerance\n');
t('standard JSON', () => {
  const r = parseTags('{"kind":"poster","tags":["海报","活动"],"text":"3D披露","people":[],"confidence":0.8}');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'poster');
  assert.deepEqual(r.tags, ['海报', '活动']);
  assert.equal(r.confidence, 0.8);
});

t('JSON wrapped in prose + ``` fences', () => {
  const r = parseTags('好的：\n```json\n{"kind":"meme","tags":["梗图"]}\n```\n还需要别的吗？');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'meme');
});

t('bare JSON with text around it (take the first balanced brace pair)', () => {
  const r = parseTags('分析结果 {"kind":"photo","tags":["合影"]} 完毕');
  assert.equal(r.ok, true);
  assert.deepEqual(r.tags, ['合影']);
});

t('a string value containing braces does not confuse brace matching', () => {
  const r = parseTags('{"kind":"poster","text":"显示 { 和 } 两个符号","tags":["海报"]}');
  assert.equal(r.ok, true);
  assert.equal(r.text, '显示 { 和 } 两个符号');
});

t('a comma-separated tags string is accepted too (models do this often)', () => {
  const r = parseTags('{"kind":"illustration","tags":"插画, 人物、粉色"}');
  assert.deepEqual(r.tags, ['插画', '人物', '粉色']);
});

t('an unknown kind lands in other, and confidence is clamped when out of range', () => {
  assert.equal(parseTags('{"kind":"乱写","tags":[]}').kind, 'other');
  assert.equal(parseTags('{"kind":"photo","confidence":9}').confidence, 1);
  assert.equal(parseTags('{"kind":"photo","confidence":"0.5"}').confidence, 0.5);
  assert.equal(parseTags('{"kind":"photo"}').confidence, null);
});

t('not JSON at all / an empty reply -> an explicit failure, with no exception thrown', () => {
  assert.equal(parseTags('抱歉，我看不了图。').ok, false);
  assert.equal(parseTags('').ok, false);
  assert.equal(parseTags(null).ok, false);
});

t('allowed kinds is a fixed set (the UI picks icons from it)', () => {
  assert.ok(IMAGE_KINDS.includes('poster') && IMAGE_KINDS.includes('meme') && IMAGE_KINDS.includes('other'));
});

t('the cache key ignores the query string (the same image with different signature params is still the same image)', () => {
  assert.equal(imageKey('https://i0.hdslb.com/a.jpg?sign=abc'), imageKey('https://i0.hdslb.com/a.jpg?sign=xyz'));
  assert.notEqual(imageKey('https://i0.hdslb.com/a.jpg'), imageKey('https://i0.hdslb.com/b.jpg'));
  assert.equal(imageKey(''), '');
});

process.stdout.write('\nvision: privacy switch\n');
t('not a single image is sent while disabled (an explicit refusal instead of a quiet send)', async () => {
  const r = await tagItems(cfgFor(1, { enabled: false }), { items: [{ id: 'x', images: ['https://example.com/a.jpg'] }] });
  assert.equal(r.ok, false);
  assert.equal(r.tagged, 0);
  assert.ok(r.error.includes('未启用'), r.error);
});

t('refused when there is no API key (it never calls out with an empty key)', () => {
  const cfg = cfgFor(1);
  cfg.llm.providers[0].apiKey = '';
  const r = visionReady(cfg);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('API Key'), r.reason);
});

process.stdout.write('\nvision: transport errors vs business errors (which decide whether to retry)\n');
t('transport errors are recognized (connection cut, dead socket, ...)', () => {
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
t('business errors are not treated as transport errors (a retry would not change the outcome)', () => {
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

process.stdout.write('\nvision: end to end (local fake vision model)\n');
const PORT = 43291;
const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(PORT)], { stdio: 'ignore' });
await sleep(900);

const items = [
  { id: 'v1', title: '嘉然 3D模型 公开', images: ['https://example.com/3d-model.jpg'], keywords: [] },
  { id: 'v2', title: '周边实物图', images: ['https://example.com/merch-goods.jpg'], keywords: [] },
  { id: 'v3', title: '活动海报', images: ['https://example.com/poster-banner.jpg'], keywords: [] },
  { id: 'v4', title: '没有配图', images: [], keywords: [] },
];

await ta('tagging succeeds, and different kinds come back per image content', async () => {
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

await ta('the cache works: a second pass calls the model for no image at all', async () => {
  const cfg = cfgFor(PORT);
  const r = await tagItems(cfg, { items });
  assert.equal(r.tagged, 0, 'nothing should be tagged twice');
  assert.equal(r.cached, 3, JSON.stringify(r));
});

await ta('force ignores the cache and tags again', async () => {
  const cfg = cfgFor(PORT);
  const r = await tagItems(cfg, { items, force: true, limit: 1 });
  assert.equal(r.tagged, 1, JSON.stringify(r));
});

await ta('tags are attached back to the item and enter the searchable keywords', async () => {
  const cfg = cfgFor(PORT);
  const cache = loadVisionCache(cfg);
  const { items: merged, tagCount } = applyVisionTags(items, cache);
  const v1 = merged.find((i) => i.id === 'v1');
  assert.deepEqual(v1.imageTags, ['3D模型', '截图']);
  assert.deepEqual(v1.imageKinds, ['screenshot']);
  assert.ok(v1.keywords.includes('3D模型'), 'image tags have to reach the keywords, otherwise search cannot hit them');
  assert.deepEqual(merged.find((i) => i.id === 'v4').imageTags, undefined, 'an item with no images must not be modified');
  assert.ok(Object.keys(tagCount).length >= 3);
});

await ta('stats show the tag distribution and the failure count', async () => {
  const s = visionStats(cfgFor(PORT));
  assert.equal(s.enabled, true);
  assert.ok(s.tagged >= 3);
  assert.ok(s.kinds.screenshot >= 1);
  assert.ok(s.topTags.length >= 3);
});

await ta('limit caps how many images are processed in one pass (not all of them at once)', async () => {
  const cfg = cfgFor(PORT);
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, title: 'x', images: [`https://example.com/new-${i}.jpg`] }));
  const r = await tagItems(cfg, { items: many, limit: 2 });
  assert.equal(r.total, 2, JSON.stringify(r));
  assert.equal(r.tagged, 2);
});

mock.kill();

// Parser tolerance across the different modes
const runMode = async (mode, port) => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(port), '--mode', mode], { stdio: 'ignore' });
  await sleep(900);
  const cfg = cfgFor(port);
  const r = await tagItems(cfg, { items: [{ id: 'x', title: 't', images: [`https://example.com/${mode}-1.jpg`] }] });
  m.kill();
  return r;
};

await ta('prose mode (JSON wrapped in a paragraph) parses too', async () => {
  const r = await runMode('prose', 43292);
  assert.equal(r.tagged, 1, JSON.stringify(r));
});

await ta('bad mode (not JSON at all) is recorded as failed, and flagged ok:false so it can be retried', async () => {
  const r = await runMode('bad', 43293);
  assert.equal(r.tagged, 0);
  assert.equal(r.failed, 1, JSON.stringify(r));
  // It has to be looked up by this image's key — the cache file is shared, and taking "the first entry" picks up an entry left behind by another test (been there)
  const cache = loadVisionCache(cfgFor(43293));
  const entry = cache[imageKey('https://example.com/bad-1.jpg')];
  assert.ok(entry, 'this image must have a record');
  assert.equal(entry.ok, false);
  assert.ok(entry.error);
});

await ta('flaky mode: a failure is not cached as a success', async () => {
  const r = await runMode('flaky', 43294);
  // the first request is a 500 -> it has to be failed
  assert.equal(r.tagged, 0, JSON.stringify(r));
  assert.equal(r.failed, 1);
});

// A transport failure (connection cut) -> retry once; an HTTP 500 is a different category and is not retried.
// This one runs on a real cut socket rather than a stub: the mock's `drop` mode destroys the first request outright.
await ta('drop mode: a transport failure is retried once, and retried is recorded honestly', async () => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(43295), '--mode', 'drop'], { stdio: 'ignore' });
  await sleep(900);
  try {
    const r = await tagItems(cfgFor(43295), { items: [{ id: 'd', title: 't', images: ['https://example.com/drop-1.jpg'] }] });
    assert.equal(r.tagged, 1, 'the retry after the cut has to succeed: ' + JSON.stringify(r));
    assert.equal(r.retried, 1, 'the single retry has to be recorded honestly: ' + JSON.stringify(r));
    assert.equal(r.failed, 0);
  } finally {
    m.kill();
  }
});

await ta('an HTTP failure is not retried (a retry would not change the outcome)', async () => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(43296), '--mode', 'flaky'], { stdio: 'ignore' });
  await sleep(900);
  try {
    const r = await tagItems(cfgFor(43296), { items: [{ id: 'f', title: 't', images: ['https://example.com/500-1.jpg'] }] });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.equal(r.retried, 0, 'a 500 must not be retried as a transport error: ' + JSON.stringify(r));
  } finally {
    m.kill();
  }
});

await ta('a failure carries its reason (not just a number)', async () => {
  const m = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-vision.cjs'), '--port', String(43297), '--mode', 'bad'], { stdio: 'ignore' });
  await sleep(900);
  try {
    const r = await tagItems(cfgFor(43297), { items: [{ id: 'e', title: 't', images: ['https://example.com/reason-1.jpg'] }] });
    assert.equal(r.failed, 1, JSON.stringify(r));
    assert.ok(Array.isArray(r.errors) && r.errors.length === 1, 'the failure reason has to be carried out: ' + JSON.stringify(r));
    assert.equal(r.errors[0].url, 'https://example.com/reason-1.jpg');
    assert.ok(r.errors[0].error, 'the reason must not be an empty string');
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

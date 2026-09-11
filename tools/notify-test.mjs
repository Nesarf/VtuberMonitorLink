// notify-test.mjs — 推送与静默时段的自检 / self-test for notification delivery
//
// 重点盯三件最容易错、而且错了很难发现的事：
//   · 跨午夜的静默时段（23:00→08:00）—— 用 `start <= t < end` 判断会永远不成立
//   · 静默期内的通知必须**进队列补发**而不是被丢掉
//   · 钉钉加签：base64 里的 + / = 必须 URL 编码，否则签名对不上
// 另外用一个**真的本地 HTTP 接收器**验证「确实发出去了、body 长什么样」。
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRequest,
  dingtalkSign,
  flushQueue,
  inQuietHours,
  isDuplicate,
  localClock,
  newTarget,
  notify,
  readQueue,
  rememberSent,
  sanitizeTarget,
  toMinutes,
  NOTIFY_KINDS,
} from '../server/src/notify.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('async test must use ta()');
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

// 一个干净的运行目录：所有测试都写在这里，不碰真实配置。
// 注意目录键必须在 cfg.paths 下 —— 我第一次写成顶层 cfg.logsDir，
// resolveDir 读的是 cfg.paths.logsDir，于是测试静默地读写仓库里**真实的** logs 目录，
// 上一次运行留下的去重记录/队列污染了这一次（表现为「首次去重判断就是重复」这种怪事）。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-notify-'));
const cfg = {
  paths: { logsDir: dir },
  notify: { targets: [], dedupeMinutes: 0, quietHours: { enabled: false } },
};
void cfg;

process.stdout.write('\nnotify: 时间解析\n');
t('HH:MM 解析与非法值', () => {
  assert.equal(toMinutes('23:00'), 1380);
  assert.equal(toMinutes('08:00'), 480);
  assert.equal(toMinutes('0:05'), 5);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('9:60'), null);
  assert.equal(toMinutes('abc'), null);
});

t('按配置时区取当地时钟（跨时区）', () => {
  const at = new Date('2026-03-05T23:30:00Z');
  assert.equal(localClock(at, 'UTC').hhmm, '23:30');
  assert.equal(localClock(at, 'Asia/Tokyo').hhmm, '08:30');
  assert.equal(localClock(at, 'America/Los_Angeles').hhmm, '15:30');
});

process.stdout.write('\nnotify: 静默时段\n');
const qcfg = (quietHours) => ({ paths: { logsDir: dir }, notify: { quietHours } });

t('关闭时不静默', () => {
  assert.equal(inQuietHours(qcfg({ enabled: false }), { at: new Date('2026-03-05T23:30:00Z') }).quiet, false);
});

t('跨午夜：23:00→08:00 在 23:30 与 03:00 都静默，12:00 不静默', () => {
  const q = { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC' };
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T23:30:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-06T03:00:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-06T12:00:00Z') }).quiet, false);
  // 边界：正好 08:00 应该已经「不静默」
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-06T08:00:00Z') }).quiet, false);
  // 边界：正好 23:00 应该「开始静默」
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T23:00:00Z') }).quiet, true);
});

t('同一天内的时段（12:00→14:00）', () => {
  const q = { enabled: true, start: '12:00', end: '14:00', timeZone: 'UTC' };
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T13:00:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T15:00:00Z') }).quiet, false);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T11:59:00Z') }).quiet, false);
});

t('start === end 视为全天静默', () => {
  assert.equal(inQuietHours(qcfg({ enabled: true, start: '00:00', end: '00:00' }), { at: new Date() }).quiet, true);
});

t('urgent 默认豁免静默', () => {
  const q = { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC' };
  const at = new Date('2026-03-05T23:30:00Z');
  assert.equal(inQuietHours(qcfg(q), { at, level: 'urgent' }).quiet, false);
  assert.equal(inQuietHours(qcfg(q), { at, level: 'info' }).quiet, true);
});

t('豁免级别可以配置', () => {
  const q = { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC', bypassLevels: [] };
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T23:30:00Z'), level: 'urgent' }).quiet, true);
});

t('只在工作日静默', () => {
  const q = { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC', days: 'weekdays' };
  // 2026-03-05 是周四 → 静默；2026-03-07 是周六 → 不静默
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T10:00:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-07T10:00:00Z') }).quiet, false);
});

t('配置写坏时 fail-open：照常推送，而不是永久静音', () => {
  // 这是刻意的设计选择：配错了导致「所有通知都不见了」比「偶尔半夜响一下」严重得多
  const r = inQuietHours(qcfg({ enabled: true, start: '23', end: '08:00' }), { at: new Date('2026-03-05T23:30:00Z') });
  assert.equal(r.quiet, false);
  assert.ok(r.error, '要带上错误信息，界面才能提示');
});

process.stdout.write('\nnotify: 渠道请求构造\n');
t('钉钉加签是确定的 HMAC，且签名做了 URL 编码', () => {
  const { sign, query } = dingtalkSign('SECtest', 1700000000000);
  const expected = crypto
    .createHmac('sha256', 'SECtest')
    .update('1700000000000\nSECtest', 'utf8')
    .digest('base64');
  assert.equal(sign, expected);
  assert.ok(query.indexOf(encodeURIComponent(expected)) !== -1, 'sign 必须整体 URL 编码');
});

t('钉钉请求带上 timestamp 与 sign', () => {
  const r = buildRequest({ kind: 'dingtalk', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: 'S3' }, { title: 'T', body: 'B' });
  assert.ok(r.url.includes('access_token=abc'));
  assert.ok(/timestamp=\d+/.test(r.url));
  assert.ok(r.url.includes('sign='));
  assert.deepEqual(JSON.parse(r.body).text, { content: 'T\n\nB' });
});

t('ntfy：中文标题必须编码进 HTTP 头（头不能含非 ASCII）', () => {
  const r = buildRequest({ kind: 'ntfy', topic: 'vml', server: 'https://ntfy.sh' }, { title: '中文标题', body: 'x' });
  assert.equal(r.url, 'https://ntfy.sh/vml');
  assert.ok(/^[\x20-\x7E]+$/.test(r.headers.Title), '头部必须是 ASCII');
  assert.equal(Buffer.from(r.headers.Title.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'), '中文标题');
});

t('企业微信 / Slack / Gotify / PushPlus / 飞书 的 URL 与体', () => {
  const wecom = buildRequest({ kind: 'wecom', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }, { title: 'T', body: 'B' });
  assert.equal(JSON.parse(wecom.body).msgtype, 'text');
  const slack = buildRequest({ kind: 'slack', webhookUrl: 'https://hooks.slack.com/services/x' }, { title: 'T', body: 'B' });
  assert.ok(JSON.parse(slack.body).text.includes('*T*'));
  const gotify = buildRequest({ kind: 'gotify', server: 'https://push.example.com', token: 'tk' }, { title: 'T', body: 'B' });
  assert.equal(gotify.url, 'https://push.example.com/message');
  assert.equal(gotify.headers['X-Gotify-Key'], 'tk');
  const pp = buildRequest({ kind: 'pushplus', token: 'tk' }, { title: 'T', body: 'B' });
  assert.equal(pp.url, 'https://www.pushplus.plus/send');
  assert.ok(pp.body.includes('token=tk'));
  const fs_ = buildRequest({ kind: 'feishu', webhookUrl: 'https://open.feishu.cn/x' }, { title: 'T', body: 'B' });
  assert.equal(JSON.parse(fs_.body).msg_type, 'text');
});

t('自定义 webhook 的 JSON 结构稳定', () => {
  const r = buildRequest({ kind: 'custom', webhookUrl: 'https://example.com/hook' }, { title: 'T', body: 'B', level: 'alert', url: 'https://x' });
  const j = JSON.parse(r.body);
  assert.equal(j.title, 'T');
  assert.equal(j.level, 'alert');
  assert.ok(j.at);
});

t('每个渠道都在 NOTIFY_KINDS 里有定义（不会漏出 UI）', () => {
  const kinds = new Set(NOTIFY_KINDS.map((k) => k.id));
  for (const k of ['bark', 'serverchan', 'telegram', 'dingtalk', 'wecom', 'ntfy', 'gotify', 'pushplus', 'slack', 'discord', 'feishu', 'custom']) {
    assert.ok(kinds.has(k), '缺少渠道定义: ' + k);
  }
});

t('渠道种类与字段都进了 newTarget / sanitizeTarget', () => {
  const tg = newTarget('dingtalk');
  assert.equal(tg.kind, 'dingtalk');
  assert.equal(tg.quiet, 'inherit');
  const s = sanitizeTarget({ kind: '不存在的', on: '乱写', quiet: '乱写' });
  assert.equal(s.kind, 'custom');
  assert.equal(s.on, 'alerts');
  assert.equal(s.quiet, 'inherit');
});

process.stdout.write('\nnotify: 去重\n');
t('开启去重后同一条内容只认一次', () => {
  const c = { paths: { logsDir: dir }, notify: { dedupeMinutes: 60 } };
  const p = { title: '同一标题', body: '同样的正文' };
  assert.equal(isDuplicate(c, p), false);
  rememberSent(c, p);
  assert.equal(isDuplicate(c, p), true);
  assert.equal(isDuplicate(c, { title: '另一个标题', body: '同样的正文' }), false);
});

t('关闭去重时永不拦截', () => {
  const c = { paths: { logsDir: dir }, notify: { dedupeMinutes: 0 } };
  const p = { title: 'x', body: 'y' };
  rememberSent(c, p);
  assert.equal(isDuplicate(c, p), false);
});

process.stdout.write('\nnotify: 队列与真实投递\n');
const received = [];
const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (d) => (buf += d));
  req.on('end', () => {
    received.push({ url: req.url, method: req.method, headers: req.headers, body: buf });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"code":0}');
  });
});
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const hookUrl = `http://127.0.0.1:${port}/hook`;

const liveCfg = {
  paths: { logsDir: dir },
  proxy: { enabled: false },
  notify: {
    dedupeMinutes: 0,
    quietHours: { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC' },
    targets: [{ ...newTarget('custom'), id: 'hook1', name: '测试接收器', webhookUrl: hookUrl, on: 'always' }],
  },
};

await ta('静默期内不发，但会进队列（不丢）', async () => {
  // 构造一个一定覆盖当前时刻的窗口：start === end 表示全天静默
  const clock = localClock(new Date(), 'UTC');
  // 注意要拼成 HH:MM —— 我第一次只传了小时（"23"），被 toMinutes 判为非法，
  // 于是走了 fail-open 直接推送。测试错了，产品行为是对的（见下面那条断言）。
  const stamp = `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`;
  liveCfg.notify.quietHours = { enabled: true, start: stamp, end: stamp, timeZone: 'UTC' };
  const verdict = inQuietHours(liveCfg, { level: 'info' });
  assert.equal(verdict.quiet, true, '全天静默应判定为静默: ' + JSON.stringify(verdict));
  const before = received.length;
  const r = await notify(liveCfg, null, { title: '夜里的通知', body: '应进队列', level: 'info' });
  assert.equal(r.sent, 0);
  assert.ok(r.queued, '应该返回队列 id');
  assert.equal(received.length, before, '静默期内不应真的投递');
  assert.ok(readQueue(liveCfg).length >= 1, '队列里应该有记录');
});

await ta('出静默期后补发，队列清空', async () => {
  liveCfg.notify.quietHours = { enabled: false };
  const before = received.length;
  const r = await flushQueue(liveCfg, null, { force: true });
  assert.ok(r.flushed >= 1, '应该补发至少一条: ' + JSON.stringify(r));
  assert.equal(received.length, before + r.flushed);
  assert.ok(received.at(-1).body.includes('应进队列'), '补发的正文要对上');
  assert.equal(readQueue(liveCfg).length, 0, '队列应清空');
});

await ta('真实投递：到达本地接收器且内容正确', async () => {
  liveCfg.notify.quietHours = { enabled: false };
  const before = received.length;
  const r = await notify(liveCfg, null, { title: '白天通知', body: '正文内容', level: 'alert' });
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.equal(received.length, before + 1);
  const got = JSON.parse(received.at(-1).body);
  assert.equal(got.title, '白天通知');
  assert.equal(got.body, '正文内容');
  assert.equal(got.level, 'alert');
});

await ta('业务失败码（code!=0）识别为失败', async () => {
  const bad = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"code":400,"message":"频率超限"}');
  });
  const bp = await new Promise((resolve) => bad.listen(0, '127.0.0.1', () => resolve(bad.address().port)));
  const c2 = {
    paths: { logsDir: dir },
    proxy: { enabled: false },
    notify: {
      dedupeMinutes: 0,
      quietHours: { enabled: false },
      // 用 custom 渠道：serverchan 的 URL 是从 key 拼出来的，指向不了本地接收器（踩过）
      targets: [{ ...newTarget('custom'), id: 'x', webhookUrl: `http://127.0.0.1:${bp}/hook`, on: 'always' }],
    },
  };
  const r = await notify(c2, null, { title: 'T', body: 'B', level: 'info' });
  assert.equal(r.sent, 0);
  assert.equal(r.results[0].error, '频率超限', JSON.stringify(r.results));
  bad.close();
});

await ta('豁免静默的目标在静默期内照发', async () => {
  liveCfg.notify.quietHours = { enabled: true, start: '00:00', end: '00:00' }; // 全天静默
  liveCfg.notify.targets[0].quiet = 'bypass';
  const before = received.length;
  const r = await notify(liveCfg, null, { title: '豁免通知', body: '立刻发', level: 'info' });
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.equal(received.length, before + 1);
  liveCfg.notify.targets[0].quiet = 'inherit';
  liveCfg.notify.quietHours = { enabled: false };
});

server.close();
fs.rmSync(dir, { recursive: true, force: true });

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

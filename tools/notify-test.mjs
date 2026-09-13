// notify-test.mjs — self-test for notification delivery
//
// Focused on the three things that are easiest to get wrong and hardest to notice once wrong:
//   · quiet hours across midnight (23:00->08:00) -- judging with `start <= t < end` is never true
//   · notifications inside quiet hours must be **queued for later delivery**, not dropped
//   · DingTalk signing: the + / = in base64 must be URL-encoded, or the signature will not match
// It also uses a **real local HTTP receiver** to verify "it really went out, and what the body looks like".
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

// A clean run directory: every test writes here, never touching the real config.
// Note the directory key must live under cfg.paths -- the first time I wrote it as a top-level cfg.logsDir,
// while resolveDir reads cfg.paths.logsDir, so the test silently read and wrote the **real** logs directory in the
// repo, and the dedupe records/queue left by the previous run polluted this one (symptoms like "the very first
// dedupe check already says duplicate", which looks bizarre).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-notify-'));
const cfg = {
  paths: { logsDir: dir },
  notify: { targets: [], dedupeMinutes: 0, quietHours: { enabled: false } },
};
void cfg;

process.stdout.write('\nnotify: time parsing\n');
t('HH:MM parsing and invalid values', () => {
  assert.equal(toMinutes('23:00'), 1380);
  assert.equal(toMinutes('08:00'), 480);
  assert.equal(toMinutes('0:05'), 5);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('9:60'), null);
  assert.equal(toMinutes('abc'), null);
});

t('the local clock follows the configured time zone (across time zones)', () => {
  const at = new Date('2026-03-05T23:30:00Z');
  assert.equal(localClock(at, 'UTC').hhmm, '23:30');
  assert.equal(localClock(at, 'Asia/Tokyo').hhmm, '08:30');
  assert.equal(localClock(at, 'America/Los_Angeles').hhmm, '15:30');
});

process.stdout.write('\nnotify: quiet hours\n');
const qcfg = (quietHours) => ({ paths: { logsDir: dir }, notify: { quietHours } });

t('nothing is quiet when disabled', () => {
  assert.equal(inQuietHours(qcfg({ enabled: false }), { at: new Date('2026-03-05T23:30:00Z') }).quiet, false);
});

t('across midnight: 23:00->08:00 is quiet at 23:30 and 03:00, not quiet at 12:00', () => {
  const q = { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC' };
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T23:30:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-06T03:00:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-06T12:00:00Z') }).quiet, false);
  // Boundary: exactly 08:00 should already be "not quiet"
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-06T08:00:00Z') }).quiet, false);
  // Boundary: exactly 23:00 should be "quiet starts"
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T23:00:00Z') }).quiet, true);
});

t('a window within the same day (12:00->14:00)', () => {
  const q = { enabled: true, start: '12:00', end: '14:00', timeZone: 'UTC' };
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T13:00:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T15:00:00Z') }).quiet, false);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T11:59:00Z') }).quiet, false);
});

t('start === end counts as quiet all day', () => {
  assert.equal(inQuietHours(qcfg({ enabled: true, start: '00:00', end: '00:00' }), { at: new Date() }).quiet, true);
});

t('urgent bypasses quiet hours by default', () => {
  const q = { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC' };
  const at = new Date('2026-03-05T23:30:00Z');
  assert.equal(inQuietHours(qcfg(q), { at, level: 'urgent' }).quiet, false);
  assert.equal(inQuietHours(qcfg(q), { at, level: 'info' }).quiet, true);
});

t('the bypass levels are configurable', () => {
  const q = { enabled: true, start: '23:00', end: '08:00', timeZone: 'UTC', bypassLevels: [] };
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T23:30:00Z'), level: 'urgent' }).quiet, true);
});

t('quiet on weekdays only', () => {
  const q = { enabled: true, start: '00:00', end: '23:59', timeZone: 'UTC', days: 'weekdays' };
  // 2026-03-05 is a Thursday -> quiet; 2026-03-07 is a Saturday -> not quiet
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-05T10:00:00Z') }).quiet, true);
  assert.equal(inQuietHours(qcfg(q), { at: new Date('2026-03-07T10:00:00Z') }).quiet, false);
});

t('fail-open on a broken config: push as usual, rather than muting forever', () => {
  // This is a deliberate design choice: a misconfiguration that makes "all notifications disappear" is far worse than "occasionally buzzing at night"
  const r = inQuietHours(qcfg({ enabled: true, start: '23', end: '08:00' }), { at: new Date('2026-03-05T23:30:00Z') });
  assert.equal(r.quiet, false);
  assert.ok(r.error, 'it must carry the error, so the UI can show it');
});

process.stdout.write('\nnotify: channel request construction\n');
t('DingTalk signing is a deterministic HMAC, and the signature is URL-encoded', () => {
  const { sign, query } = dingtalkSign('SECtest', 1700000000000);
  const expected = crypto
    .createHmac('sha256', 'SECtest')
    .update('1700000000000\nSECtest', 'utf8')
    .digest('base64');
  assert.equal(sign, expected);
  assert.ok(query.indexOf(encodeURIComponent(expected)) !== -1, 'the sign must be URL-encoded as a whole');
});

t('the DingTalk request carries timestamp and sign', () => {
  const r = buildRequest({ kind: 'dingtalk', webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc', secret: 'S3' }, { title: 'T', body: 'B' });
  assert.ok(r.url.includes('access_token=abc'));
  assert.ok(/timestamp=\d+/.test(r.url));
  assert.ok(r.url.includes('sign='));
  assert.deepEqual(JSON.parse(r.body).text, { content: 'T\n\nB' });
});

t('ntfy: a Chinese title must be encoded into the HTTP header (headers cannot hold non-ASCII)', () => {
  const r = buildRequest({ kind: 'ntfy', topic: 'vml', server: 'https://ntfy.sh' }, { title: '中文标题', body: 'x' });
  assert.equal(r.url, 'https://ntfy.sh/vml');
  assert.ok(/^[\x20-\x7E]+$/.test(r.headers.Title), 'the header must be ASCII');
  assert.equal(Buffer.from(r.headers.Title.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'), '中文标题');
});

t('the URL and body of WeCom / Slack / Gotify / PushPlus / Feishu', () => {
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

t('the JSON shape of a custom webhook is stable', () => {
  const r = buildRequest({ kind: 'custom', webhookUrl: 'https://example.com/hook' }, { title: 'T', body: 'B', level: 'alert', url: 'https://x' });
  const j = JSON.parse(r.body);
  assert.equal(j.title, 'T');
  assert.equal(j.level, 'alert');
  assert.ok(j.at);
});

t('every channel is defined in NOTIFY_KINDS (a missing entry would drop it from the UI)', () => {
  const kinds = new Set(NOTIFY_KINDS.map((k) => k.id));
  for (const k of ['bark', 'serverchan', 'telegram', 'dingtalk', 'wecom', 'ntfy', 'gotify', 'pushplus', 'slack', 'discord', 'feishu', 'custom']) {
    assert.ok(kinds.has(k), 'missing channel definition: ' + k);
  }
});

t('newTarget / sanitizeTarget both fall back to sane kind and field values', () => {
  const tg = newTarget('dingtalk');
  assert.equal(tg.kind, 'dingtalk');
  assert.equal(tg.quiet, 'inherit');
  const s = sanitizeTarget({ kind: '不存在的', on: '乱写', quiet: '乱写' });
  assert.equal(s.kind, 'custom');
  assert.equal(s.on, 'alerts');
  assert.equal(s.quiet, 'inherit');
});

process.stdout.write('\nnotify: dedupe\n');
t('with dedupe on, the same content is accepted only once', () => {
  const c = { paths: { logsDir: dir }, notify: { dedupeMinutes: 60 } };
  const p = { title: '同一标题', body: '同样的正文' };
  assert.equal(isDuplicate(c, p), false);
  rememberSent(c, p);
  assert.equal(isDuplicate(c, p), true);
  assert.equal(isDuplicate(c, { title: '另一个标题', body: '同样的正文' }), false);
});

t('nothing is ever blocked when dedupe is off', () => {
  const c = { paths: { logsDir: dir }, notify: { dedupeMinutes: 0 } };
  const p = { title: 'x', body: 'y' };
  rememberSent(c, p);
  assert.equal(isDuplicate(c, p), false);
});

process.stdout.write('\nnotify: queue and real delivery\n');
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

await ta('inside quiet hours nothing is sent, but it is queued (not lost)', async () => {
  // Build a window that certainly covers the current moment: start === end means quiet all day
  const clock = localClock(new Date(), 'UTC');
  // Note it has to be assembled as HH:MM -- the first time I passed only the hour ("23"), toMinutes judged it
  // invalid, and it went fail-open and pushed directly. The test was wrong, the product behaviour was right
  // (see the assertion below).
  const stamp = `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`;
  liveCfg.notify.quietHours = { enabled: true, start: stamp, end: stamp, timeZone: 'UTC' };
  const verdict = inQuietHours(liveCfg, { level: 'info' });
  assert.equal(verdict.quiet, true, 'quiet all day should be judged quiet: ' + JSON.stringify(verdict));
  const before = received.length;
  const r = await notify(liveCfg, null, { title: '夜里的通知', body: '应进队列', level: 'info' });
  assert.equal(r.sent, 0);
  assert.ok(r.queued, 'it should return a queue id');
  assert.equal(received.length, before, 'nothing should really be delivered inside quiet hours');
  assert.ok(readQueue(liveCfg).length >= 1, 'there should be a record in the queue');
});

await ta('once quiet hours end the queued notification goes out and the queue is emptied', async () => {
  liveCfg.notify.quietHours = { enabled: false };
  const before = received.length;
  const r = await flushQueue(liveCfg, null, { force: true });
  assert.ok(r.flushed >= 1, 'it should deliver at least one late: ' + JSON.stringify(r));
  assert.equal(received.length, before + r.flushed);
  assert.ok(received.at(-1).body.includes('应进队列'), 'the late-delivered body has to match');
  assert.equal(readQueue(liveCfg).length, 0, 'the queue should be emptied');
});

await ta('real delivery: it reaches the local receiver with the right content', async () => {
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

await ta('a business failure code (code!=0) is recognized as a failure', async () => {
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
      // Uses the custom channel: serverchan's URL is assembled from the key, so it cannot point at a local receiver (learned the hard way)
      targets: [{ ...newTarget('custom'), id: 'x', webhookUrl: `http://127.0.0.1:${bp}/hook`, on: 'always' }],
    },
  };
  const r = await notify(c2, null, { title: 'T', body: 'B', level: 'info' });
  assert.equal(r.sent, 0);
  assert.equal(r.results[0].error, '频率超限', JSON.stringify(r.results));
  bad.close();
});

await ta('a target that bypasses quiet hours still sends during them', async () => {
  liveCfg.notify.quietHours = { enabled: true, start: '00:00', end: '00:00' }; // quiet all day
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

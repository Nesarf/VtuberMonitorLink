// dormant-test.mjs — self-test for the "dormant / graduated" block
// The boundary of this rule is delicate: one day off misclassifies a whole category of people. So both sides of the threshold, comebacks and never-recorded people are all pinned down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DORMANT_DEFAULTS, daysSince, dormantBlock, isDormant } from '../server/src/dormant.js';
import { ingestItems, latestItemsByPerson, openArchive } from '../server/src/archive.js';

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

const NOW = new Date('2026-09-30T12:00:00Z');
const people = [
  { id: 'grad', name: '已毕业', agency: 'BOX' },
  { id: 'idle', name: '长期休止', agency: 'BOX' },
  { id: 'active', name: '在更的', agency: 'BOX' },
  { id: 'back', name: '回来了', agency: 'BOX' },
  { id: 'never', name: '没见过', agency: 'BOX' },
];

process.stdout.write('\ndormant: threshold\n');

t('either side of half a year (6 months by default): landing exactly on the threshold counts, one day short does not', () => {
  const th = Math.round(6 * 30.44); // 183 days (a year counted as 365.28 days, a month as 30.44)
  const at = (days) => new Date(Date.parse('2026-09-30T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  assert.equal(isDormant({ lastDay: at(th), now: NOW }).dormant, true, `${th} days ago must count as dormant`);
  assert.equal(isDormant({ lastDay: at(th - 1), now: NOW }).dormant, false, `${th - 1} days ago must not count yet`);
  assert.equal(isDormant({ lastDay: at(th), now: NOW }).thresholdDays, th);
  // Pin one date down as cross-validation: 2026-04-02 to 2026-09-30 is 181 days -> below 183
  assert.equal(daysSince('2026-04-02', NOW), 181);
  assert.equal(isDormant({ lastDay: '2026-04-02', now: NOW }).dormant, false);
  assert.equal(isDormant({ lastDay: '2026-03-20', now: NOW }).dormant, true, '194 days ago is plainly dormant');
});

t('the months threshold is adjustable: at 3 months, 100 days ago already counts', () => {
  assert.equal(isDormant({ lastDay: '2026-06-22', now: NOW, months: 3 }).dormant, true);
  assert.equal(isDormant({ lastDay: '2026-06-22', now: NOW, months: 6 }).dormant, false);
});

t('no date -> no judgement (not treated as "dormant")', () => {
  assert.deepEqual(isDormant({ lastDay: null, now: NOW }), { dormant: false, days: null });
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince('2026-09-30', NOW), 0);
  assert.equal(daysSince('2026-09-01', NOW), 29);
});

process.stdout.write('\ndormant: block\n');

const byDay = {
  grad: { '2026-03-01': 2, '2026-03-10': 1 }, // last 3-10, about 6.7 months ago
  idle: { '2025-12-20': 1 }, // about 9.4 months ago
  active: { '2026-09-29': 3, '2026-09-28': 1 }, // normal
  back: { '2026-01-15': 1, '2026-09-29': 1 }, // moved again after 8 months asleep
};
const latest = {
  grad: [{ title: '最后一条动态', day: '2026-03-10', url: 'https://example.com/grad' }],
  idle: [{ title: '休止公告', day: '2025-12-20', url: 'https://example.com/idle' }],
  back: [{ title: '复出直播预告', day: '2026-09-29', url: 'https://example.com/back' }],
};

t('dormant people are listed; active people are not; people never recorded are not', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, todayPeople: [], now: NOW });
  const names = block.dormant.map((d) => d.name);
  assert.ok(names.includes('已毕业'), names.join(','));
  assert.ok(names.includes('长期休止'));
  assert.ok(!names.includes('在更的'), 'an active person must not show up');
  assert.ok(!names.includes('没见过'), 'someone with no record is not "dormant", they are "never seen"');
  assert.equal(block.skipped, 1, 'people with no record must be counted in `skipped`');
});

t('returned people rank first and are flagged separately (that is the item most worth seeing)', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, todayPeople: ['back'], now: NOW });
  assert.equal(block.dormant[0].name, '回来了', 'the returned one must rank first: ' + block.dormant.map((d) => d.name).join(','));
  assert.equal(block.returnees.length, 1);
  assert.match(block.markdown, /可能有动静了/);
  assert.ok(block.markdown.indexOf('回来了') < block.markdown.indexOf('已毕业'), 'the comeback block must come before the dormant list');
});

t('markdown shape: heading, months, and each person\'s latest content with its link', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, now: NOW });
  assert.match(block.markdown, /^## 🌙 停止活动/);
  const grad = block.dormant.find((d) => d.name === '已毕业');
  assert.equal(grad.months, 6.7, 'about 6.7 months, actually ' + grad.months);
  assert.match(block.markdown, /最后 2026-03-10（约 6.7 个月前）/);
  assert.match(block.markdown, /https:\/\/example\.com\/grad/);
  assert.match(block.markdown, /休止公告/);
});

t('the people and item caps take effect, and the overflow says how many more there are', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, name: '人' + i, agency: 'B' }));
  const manyByDay = Object.fromEntries(many.map((p) => [p.id, { '2026-01-01': 1 }]));
  const block = dormantBlock({ people: many, byDay: manyByDay, latestItems: {}, rules: { maxPeople: 5 }, now: NOW });
  assert.equal(block.dormant.length, 5);
  assert.equal(block.hidden, 15);
  assert.match(block.markdown, /另有 15 位/);

  const block2 = dormantBlock({
    people: [people[0]],
    byDay: { grad: byDay.grad },
    latestItems: { grad: [1, 2, 3, 4].map((n) => ({ title: 't' + n, day: '2026-03-10' })) },
    rules: { maxItems: 2 },
    now: NOW,
  });
  assert.equal(block2.dormant[0].items.length, 2, 'at most 2 items per person');
});

t('switching it off produces nothing at all', () => {
  const block = dormantBlock({ people, byDay, latestItems: latest, rules: { enabled: false }, now: NOW });
  assert.deepEqual(block, { dormant: [], returnees: [], markdown: '', skipped: 0 });
});

t('an empty roster does not blow up', () => {
  const block = dormantBlock({ people: [], byDay: {}, now: NOW });
  assert.equal(block.markdown, '');
  assert.deepEqual(block.dormant, []);
});

process.stdout.write('\ndormant: "latest content" taken from the archive\n');

await t('latestItemsByPerson: the latest few per person (ordered by the item\'s own date, not the ingest day)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-dorm-'));
  const cfg = { paths: { feedsDir: dir, reportsDir: dir, logsDir: dir } };
  const db = openArchive(cfg);
  // Everything is ingested "today" (as in a backfill run), while the content's own dates span half a year —
  // which is exactly the shape the "dormant" block has to deal with
  ingestItems(db, [
    { id: 'i1', publishedAt: '2026-03-01T00:00:00Z', title: '老内容', url: 'https://x/1', people: ['grad'], text: '' },
    { id: 'i2', publishedAt: '2026-03-10T00:00:00Z', title: '最后一条', url: 'https://x/2', people: ['grad'], text: '' },
    { id: 'i3', publishedAt: '2026-09-29T00:00:00Z', title: '今天的', url: 'https://x/3', people: ['active'], text: '' },
    { id: 'i4', title: '没有自己日期的条目', url: 'https://x/4', people: ['grad'], text: '' },
  ], { day: '2026-09-30' });

  const map = latestItemsByPerson(db, { personIds: ['grad', 'active'], limit: 1 });
  assert.equal(map.grad[0].title, '最后一条', 'the newest one (by content date) is expected, actually ' + map.grad[0].title);
  assert.equal(map.grad[0].day, '2026-03-10');
  assert.equal(map.active[0].title, '今天的');
  assert.deepEqual(
    latestItemsByPerson(db, { personIds: ['grad'], limit: 3 }).grad.map((r) => r.title),
    ['最后一条', '老内容', '没有自己日期的条目'],
    'content date descending; items without published_at fall back to the ingest day',
  );
  assert.deepEqual(latestItemsByPerson(db, { personIds: ['nobody'] }).nobody, [], 'someone with no items returns an empty array instead of throwing');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

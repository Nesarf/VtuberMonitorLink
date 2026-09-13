// people-test.mjs — self-test for the "follow by person" matching logic
//
// Person-name matching is most prone to two classes of problem, and neither raises an error —
// they just quietly produce wrong results:
//   · **false negatives**: CJK has no word boundaries, so a \b-based match for the CJK name of
//     the `jaran` fixture never finds it inside a headline that wraps it in brackets (see the
//     matchItem fixtures below)
//   · **false positives**: matching Latin names by substring, so `Rei` hits `Reimu` and `Mika` hits `Mikado`
// So both classes are pinned down here, plus the rule that "a hit must carry evidence"
// (the UI has to be able to explain why an item counts as that person's).
import assert from 'node:assert/strict';
import {
  aliasesOf,
  annotateItems,
  buildMatchers,
  feedByPerson,
  matchItem,
  personExport,
  sanitizePerson,
  suggestFromPeople,
} from '../server/src/people.js';

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

const people = [
  {
    id: 'jaran',
    name: '嘉然',
    enName: 'Diana',
    agency: 'A-SOUL',
    aliases: ['嘉然今天吃什么', 'Jia Ran'],
    links: { bilibili: '672328094', twitter: '@diana_aso' },
    enabled: true,
  },
  {
    id: 'rei',
    name: 'Rei',
    aliases: ['レイ'],
    links: { youtube: 'ReiChannel' },
    enabled: true,
  },
  { id: 'off', name: '关闭的人', aliases: [], enabled: false },
];

process.stdout.write('\npeople: alias extraction\n');
t('name / English name / aliases / accounts / uid are all collected', () => {
  const a = aliasesOf(people[0]).map((x) => x.value);
  assert.ok(a.includes('嘉然'));
  assert.ok(a.includes('Diana'));
  assert.ok(a.includes('嘉然今天吃什么'));
  assert.ok(a.includes('672328094'), 'uid should take part in matching');
  assert.ok(a.includes('space.bilibili.com/672328094'), 'uid link shape');
  assert.ok(a.includes('diana_aso') && a.includes('@diana_aso'), 'both the handle with and without @ must be covered');
});

t('too-short aliases are dropped (so one single character does not falsely match everywhere)', () => {
  const a = aliasesOf({ id: 'x', name: 'AB', aliases: ['R', ''] }).map((x) => x.value);
  assert.ok(!a.includes('R'));
});

process.stdout.write('\npeople: matching (CJK substring + Latin word boundary)\n');
const M = buildMatchers(people);

t('a CJK name matches inside a title (even with no word boundary)', () => {
  const r = matchItem({ title: '【嘉然】今天有新动态' }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'title');
  assert.equal(r.hits[0].alias, '嘉然');
});

t('a Latin name matches as a whole word, not as a substring (the standalone "Mika" hits, "Reimu" does not)', () => {
  assert.deepEqual(matchItem({ title: 'Mikado is not Mika' }, buildMatchers([{ id: 'm', name: 'Mika', enabled: true }])).ids, ['m']);
  // "Reimu" contains "Rei" only as a substring, never as a whole word, so it must not count as a hit
  const r = matchItem({ title: 'Reimu Hakurei 的直播' }, M);
  assert.ok(!r.ids.includes('rei'), 'Reimu must not match Rei');
});

t('matching is case-insensitive', () => {
  assert.deepEqual(matchItem({ title: 'REI 新曲发布' }, M).ids, ['rei']);
  assert.deepEqual(matchItem({ title: 'diana 生日' }, M).ids, ['jaran']);
});

t('a kana alias can match', () => {
  assert.deepEqual(matchItem({ title: 'レイの3D披露' }, M).ids, ['rei']);
});

t('a uid matches inside a URL field (a source-page URL)', () => {
  const r = matchItem({ title: '某条动态', url: 'https://space.bilibili.com/672328094/dynamic' }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'url');
});

t('a handle matches the @ form', () => {
  assert.deepEqual(matchItem({ text: 'via @diana_aso' }, M).ids, ['jaran']);
});

t('a disabled watch target takes no part in matching', () => {
  assert.deepEqual(matchItem({ title: '关闭的人 发了什么' }, M).ids, []);
});

t('two people in one item -> both count as hits, each carrying evidence', () => {
  const r = matchItem({ title: '嘉然 和 Rei 联动' }, M);
  assert.deepEqual(r.ids.sort(), ['jaran', 'rei']);
  assert.equal(r.hits.length, 2);
  for (const h of r.hits) {
    assert.ok(h.alias && h.source && h.field, 'every hit has to be explainable');
  }
});

t('the same person is recorded only once per field (no repeated hits)', () => {
  const r = matchItem({ title: '嘉然 嘉然 嘉然' }, M);
  assert.equal(r.hits.filter((h) => h.field === 'title').length, 1);
});

t('attribution works when the source name is itself a person name (the "bilibili feed · Jaran…" kind)', () => {
  const r = matchItem({ title: '今天发了一条动态', sourceName: 'B站动态 · 嘉然今天吃什么' }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'sourceName');
});

t('a localized object field (sourceName being {zh,en}) has to match as well', () => {
  // This is the real shape: a plain String({zh,en}) yields "[object Object]" and silently kills attribution
  const r = matchItem({ title: '新动态', sourceName: { zh: 'B站动态 · 嘉然今天吃什么', en: 'bilibili · Diana' } }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'sourceName');
  // The English one has to be able to hit too
  const r2 = matchItem({ title: 'x', sourceName: { zh: '某来源', en: 'Diana channel' } }, M);
  assert.deepEqual(r2.ids, ['jaran']);
});

t('nothing matchable inside the item means no false hit', () => {
  const r = matchItem({ title: 'x', sourceName: { zh: '无关来源', en: 'unrelated' } }, M);
  assert.deepEqual(r.ids, []);
});

t('an unrelated item matches nobody', () => {
  assert.deepEqual(matchItem({ title: '某游戏更新公告' }, M).ids, []);
});

process.stdout.write('\npeople: batch attribution and aggregation\n');
const items = [
  { id: 'a', title: '【嘉然】新动态', publishedAt: '2026-09-01T10:00:00Z' },
  { id: 'b', title: 'Rei 宣布 3D 披露', publishedAt: '2026-09-05T10:00:00Z' },
  { id: 'c', title: '无关新闻', publishedAt: '2026-09-06T10:00:00Z' },
  { id: 'd', title: '嘉然 与 Rei 联动预告', publishedAt: '2026-09-07T10:00:00Z' },
];

t('batch attribution counts are correct (including an item that hits two people)', () => {
  const r = annotateItems(items, people);
  assert.equal(r.matched, 3, 'a/b/d, three items matched');
  assert.equal(r.items[0].people[0], 'jaran');
  assert.deepEqual(r.items[3].people.sort(), ['jaran', 'rei']);
});

t('per-person aggregation: count, most recent time, sorted by recency', () => {
  const feed = feedByPerson(items, people);
  const jaran = feed.find((f) => f.person.id === 'jaran');
  const rei = feed.find((f) => f.person.id === 'rei');
  assert.equal(jaran.count, 2);
  assert.equal(rei.count, 2);
  assert.equal(jaran.lastAt, '2026-09-07T10:00:00Z');
  // jaran and rei share the same most recent time -> then by count; if both are equal the order does not matter, but both must be in the list
  // `... || true` made this vacuous (it could never fail); the point is that a followed person with
  // no hits is still *in* the list, which the next two lines now actually check.
  assert.ok(feed.some((f) => f.person.id === 'off'), 'a followed person with no hits must appear in the list too (count 0)');
  const off = feed.find((f) => f.person.id === 'off');
  assert.equal(off.count, 0, 'someone with no activity stays in the list, just with count 0');
});

t('filtering by a single person returns only that person', () => {
  const feed = feedByPerson(items, people, { id: 'rei' });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].person.id, 'rei');
  assert.equal(feed[0].items.length, 2);
  assert.ok(feed[0].items[0].peopleHits.length >= 1, 'a single-person item has to carry which alias hit');
});

process.stdout.write('\npeople: import suggestions and export\n');
t('suggest watch targets from entity statistics, with already-followed ones excluded', () => {
  const entities = [
    { value: '嘉然', count: 9 },
    { value: '新出现的某人', count: 5 },
    { value: '只出现一次', count: 1 },
  ];
  const s = suggestFromPeople(entities, people, { minCount: 2 });
  const names = s.map((x) => x.name);
  assert.ok(!names.includes('嘉然'), 'do not re-suggest someone already followed');
  assert.ok(names.includes('新出现的某人'));
  assert.ok(!names.includes('只出现一次'), 'below-threshold ones are not suggested');
});

t('the JSON and Markdown exports both carry the person and the items', () => {
  const feed = feedByPerson(items, people, { id: 'jaran' })[0];
  const js = personExport(feed.person, feed.items, 'json');
  const parsed = JSON.parse(js.body);
  assert.equal(parsed.person.id, 'jaran');
  assert.equal(parsed.count, 2);
  const md = personExport(feed.person, feed.items, 'md');
  assert.ok(md.body.includes('# 嘉然'));
  assert.ok(md.body.includes('共 2 条'));
});

process.stdout.write('\npeople: input validation\n');
t('a name is required; the id gets sanitized', () => {
  assert.ok(sanitizePerson({ name: '' }).error);
  const { person } = sanitizePerson({ id: '有 空格/斜杠', name: '测试' });
  assert.ok(/^[A-Za-z0-9._-]+$/.test(person.id));
});

t('aliases are de-duplicated, blanks dropped, length capped', () => {
  const { person } = sanitizePerson({ name: 'X', aliases: ['a1', 'a1', ' ', 'b2'] });
  assert.deepEqual(person.aliases, ['a1', 'b2']);
});

t('only three notification levels are allowed, default alert', () => {
  assert.equal(sanitizePerson({ name: 'X' }).person.notifyLevel, 'alert');
  assert.equal(sanitizePerson({ name: 'X', notifyLevel: 'urgent' }).person.notifyLevel, 'urgent');
  assert.equal(sanitizePerson({ name: 'X', notifyLevel: '乱写' }).person.notifyLevel, 'alert');
});

t('links keeps only the recognized keys', () => {
  const { person } = sanitizePerson({ name: 'X', links: { bilibili: '123', 乱七八糟: 'y' } });
  assert.deepEqual(Object.keys(person.links), ['bilibili']);
});

t('**not limited to bilibili**: accounts on twitch / acfun / niconico / weibo and the like all have to survive', () => {
  const { person } = sanitizePerson({
    name: 'Y',
    links: { twitch: 'someone_tv', acfun: '123456', niconico: '999', weibo: '7595006312', youtube: 'UCabc', 乱七八糟: 'z' },
  });
  assert.deepEqual(Object.keys(person.links).sort(), ['acfun', 'niconico', 'twitch', 'weibo', 'youtube']);
});

t('aliases are generated from links on **any platform** (not only bilibili)', () => {
  const p = { id: 'p1', name: '甲', links: { twitch: 'someone_tv', youtube: 'UCabc', twitter: 'SomeOne', bilibili: '672328094' } };
  const vals = aliasesOf(p).map((a) => a.value);
  assert.ok(vals.includes('someone_tv'), 'the twitch name itself');
  assert.ok(vals.includes('twitch.tv/someone_tv'), 'the twitch link shape');
  assert.ok(vals.includes('youtube.com/channel/UCabc'), 'the youtube channel link');
  assert.ok(vals.includes('@SomeOne'), 'the @ form of the twitter handle');
  assert.ok(vals.includes('space.bilibili.com/672328094'), 'the bilibili link (the existing behaviour must not be lost)');
});

t('the alias source records the platform (so the UI can explain why an item belongs to this person)', () => {
  const p = { id: 'p2', name: '乙', links: { twitch: 'abc_tv' } };
  const hit = aliasesOf(p).find((a) => a.value === 'abc_tv');
  assert.equal(hit.source, 'twitch-id');
  const url = aliasesOf(p).find((a) => a.value === 'twitch.tv/abc_tv');
  assert.equal(url.source, 'twitch-url');
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

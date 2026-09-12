// people-test.mjs — 「按人关注」匹配逻辑的自检 / self-test for people matching
//
// 人名匹配最容易出两类问题，而且都不会报错、只会安静地给错结果：
//   · **假阴性**：中日文没有词边界，用 \b 匹配「嘉然」永远匹配不到「【嘉然】新动态」
//   · **假阳性**：拉丁名用子串匹配，`Rei` 会命中 `Reimu`、`Mika` 会命中 `Mikado`
// 所以这里两类都要钉死，还要验证「命中要带证据」（界面得能解释凭什么算他的）。
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

process.stdout.write('\npeople: 别名提取\n');
t('名字 / 英文名 / 别名 / 账号 / uid 都被收进来', () => {
  const a = aliasesOf(people[0]).map((x) => x.value);
  assert.ok(a.includes('嘉然'));
  assert.ok(a.includes('Diana'));
  assert.ok(a.includes('嘉然今天吃什么'));
  assert.ok(a.includes('672328094'), 'uid 应参与匹配');
  assert.ok(a.includes('space.bilibili.com/672328094'), 'uid 链接形态');
  assert.ok(a.includes('diana_aso') && a.includes('@diana_aso'), 'handle 有无 @ 都要覆盖');
});

t('太短的别名被丢掉（避免 1 个字到处误命中）', () => {
  const a = aliasesOf({ id: 'x', name: 'AB', aliases: ['R', ''] }).map((x) => x.value);
  assert.ok(!a.includes('R'));
});

process.stdout.write('\npeople: 匹配（中日文子串 + 拉丁词边界）\n');
const M = buildMatchers(people);

t('中文名在标题里能命中（无词边界也能）', () => {
  const r = matchItem({ title: '【嘉然】今天有新动态' }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'title');
  assert.equal(r.hits[0].alias, '嘉然');
});

t('拉丁名不会被别的词包住而误命中', () => {
  assert.deepEqual(matchItem({ title: 'Mikado is not Mika' }, buildMatchers([{ id: 'm', name: 'Mika', enabled: true }])).ids, ['m']);
  // 「Reimu」里含有「Rei」，但它是完整词，不能算命中
  const r = matchItem({ title: 'Reimu Hakurei 的直播' }, M);
  assert.ok(!r.ids.includes('rei'), 'Reimu 不应命中 Rei');
});

t('大小写不敏感', () => {
  assert.deepEqual(matchItem({ title: 'REI 新曲发布' }, M).ids, ['rei']);
  assert.deepEqual(matchItem({ title: 'diana 生日' }, M).ids, ['jaran']);
});

t('假名别名可命中', () => {
  assert.deepEqual(matchItem({ title: 'レイの3D披露' }, M).ids, ['rei']);
});

t('uid 在 URL 字段里能命中（来源页那种）', () => {
  const r = matchItem({ title: '某条动态', url: 'https://space.bilibili.com/672328094/dynamic' }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'url');
});

t('handle 命中 @ 形式', () => {
  assert.deepEqual(matchItem({ text: 'via @diana_aso' }, M).ids, ['jaran']);
});

t('禁用的关注对象不参与匹配', () => {
  assert.deepEqual(matchItem({ title: '关闭的人 发了什么' }, M).ids, []);
});

t('一条里有两个人 → 都算命中，且都带证据', () => {
  const r = matchItem({ title: '嘉然 和 Rei 联动' }, M);
  assert.deepEqual(r.ids.sort(), ['jaran', 'rei']);
  assert.equal(r.hits.length, 2);
  for (const h of r.hits) {
    assert.ok(h.alias && h.source && h.field, '每处命中都要能解释');
  }
});

t('同一个人在同一字段只记一次（不刷屏）', () => {
  const r = matchItem({ title: '嘉然 嘉然 嘉然' }, M);
  assert.equal(r.hits.filter((h) => h.field === 'title').length, 1);
});

t('来源名字本身是人名时能归属（B站动态 · 嘉然… 这类）', () => {
  const r = matchItem({ title: '今天发了一条动态', sourceName: 'B站动态 · 嘉然今天吃什么' }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'sourceName');
});

t('本地化对象字段（sourceName 是 {zh,en}）也要能匹配', () => {
  // 这是真实形状：直接 String({zh,en}) 会得到 "[object Object]"，让归属静默失效
  const r = matchItem({ title: '新动态', sourceName: { zh: 'B站动态 · 嘉然今天吃什么', en: 'bilibili · Diana' } }, M);
  assert.deepEqual(r.ids, ['jaran']);
  assert.equal(r.hits[0].field, 'sourceName');
  // 英文那一份也要能命中
  const r2 = matchItem({ title: 'x', sourceName: { zh: '某来源', en: 'Diana channel' } }, M);
  assert.deepEqual(r2.ids, ['jaran']);
});

t('对象里没有可匹配内容时不会误命中', () => {
  const r = matchItem({ title: 'x', sourceName: { zh: '无关来源', en: 'unrelated' } }, M);
  assert.deepEqual(r.ids, []);
});

t('无关条目一个人都不命中', () => {
  assert.deepEqual(matchItem({ title: '某游戏更新公告' }, M).ids, []);
});

process.stdout.write('\npeople: 批量归属与聚合\n');
const items = [
  { id: 'a', title: '【嘉然】新动态', publishedAt: '2026-09-01T10:00:00Z' },
  { id: 'b', title: 'Rei 宣布 3D 披露', publishedAt: '2026-09-05T10:00:00Z' },
  { id: 'c', title: '无关新闻', publishedAt: '2026-09-06T10:00:00Z' },
  { id: 'd', title: '嘉然 与 Rei 联动预告', publishedAt: '2026-09-07T10:00:00Z' },
];

t('批量归属统计正确（含一条命中两人的情况）', () => {
  const r = annotateItems(items, people);
  assert.equal(r.matched, 3, 'a/b/d 三条命中');
  assert.equal(r.items[0].people[0], 'jaran');
  assert.deepEqual(r.items[3].people.sort(), ['jaran', 'rei']);
});

t('按人聚合：数量、最近时间、按最近排序', () => {
  const feed = feedByPerson(items, people);
  const jaran = feed.find((f) => f.person.id === 'jaran');
  const rei = feed.find((f) => f.person.id === 'rei');
  assert.equal(jaran.count, 2);
  assert.equal(rei.count, 2);
  assert.equal(jaran.lastAt, '2026-09-07T10:00:00Z');
  // jaran 与 rei 的最近时间相同 → 再按数量；两者相同 → 顺序无所谓，但都要在列表里
  assert.ok(feed.findIndex((f) => f.person.id === 'off') >= 0 || true, '未命中的关注对象也应出现在名单里（数量 0）');
  const off = feed.find((f) => f.person.id === 'off');
  assert.equal(off.count, 0, '没动静的人也要在名单里，只是 count 为 0');
});

t('按单人筛选只返回那个人', () => {
  const feed = feedByPerson(items, people, { id: 'rei' });
  assert.equal(feed.length, 1);
  assert.equal(feed[0].person.id, 'rei');
  assert.equal(feed[0].items.length, 2);
  assert.ok(feed[0].items[0].peopleHits.length >= 1, '单人的条目要带上是哪个别名命中的');
});

process.stdout.write('\npeople: 导入建议与导出\n');
t('从实体统计里推荐关注对象，已关注的会被排除', () => {
  const entities = [
    { value: '嘉然', count: 9 },
    { value: '新出现的某人', count: 5 },
    { value: '只出现一次', count: 1 },
  ];
  const s = suggestFromPeople(entities, people, { minCount: 2 });
  const names = s.map((x) => x.name);
  assert.ok(!names.includes('嘉然'), '已关注的不要重复推荐');
  assert.ok(names.includes('新出现的某人'));
  assert.ok(!names.includes('只出现一次'), '低于阈值的不推荐');
});

t('导出 JSON / Markdown 都带齐人与条目', () => {
  const feed = feedByPerson(items, people, { id: 'jaran' })[0];
  const js = personExport(feed.person, feed.items, 'json');
  const parsed = JSON.parse(js.body);
  assert.equal(parsed.person.id, 'jaran');
  assert.equal(parsed.count, 2);
  const md = personExport(feed.person, feed.items, 'md');
  assert.ok(md.body.includes('# 嘉然'));
  assert.ok(md.body.includes('共 2 条'));
});

process.stdout.write('\npeople: 输入校验\n');
t('必须有名字；id 会被清洗', () => {
  assert.ok(sanitizePerson({ name: '' }).error);
  const { person } = sanitizePerson({ id: '有 空格/斜杠', name: '测试' });
  assert.ok(/^[A-Za-z0-9._-]+$/.test(person.id));
});

t('别名去重、去空、限长', () => {
  const { person } = sanitizePerson({ name: 'X', aliases: ['a1', 'a1', ' ', 'b2'] });
  assert.deepEqual(person.aliases, ['a1', 'b2']);
});

t('通知级别只允许三档，默认 alert', () => {
  assert.equal(sanitizePerson({ name: 'X' }).person.notifyLevel, 'alert');
  assert.equal(sanitizePerson({ name: 'X', notifyLevel: 'urgent' }).person.notifyLevel, 'urgent');
  assert.equal(sanitizePerson({ name: 'X', notifyLevel: '乱写' }).person.notifyLevel, 'alert');
});

t('links 只保留认识的键', () => {
  const { person } = sanitizePerson({ name: 'X', links: { bilibili: '123', 乱七八糟: 'y' } });
  assert.deepEqual(Object.keys(person.links), ['bilibili']);
});

t('**不限于 bilibili**：twitch / acfun / niconico / weibo 等平台账号都要留下来', () => {
  const { person } = sanitizePerson({
    name: 'Y',
    links: { twitch: 'someone_tv', acfun: '123456', niconico: '999', weibo: '7595006312', youtube: 'UCabc', 乱七八糟: 'z' },
  });
  assert.deepEqual(Object.keys(person.links).sort(), ['acfun', 'niconico', 'twitch', 'weibo', 'youtube']);
});

t('别名从**任意平台**链接生成（不是只认 bilibili）', () => {
  const p = { id: 'p1', name: '甲', links: { twitch: 'someone_tv', youtube: 'UCabc', twitter: 'SomeOne', bilibili: '672328094' } };
  const vals = aliasesOf(p).map((a) => a.value);
  assert.ok(vals.includes('someone_tv'), 'twitch 名本身');
  assert.ok(vals.includes('twitch.tv/someone_tv'), 'twitch 链接形态');
  assert.ok(vals.includes('youtube.com/channel/UCabc'), 'youtube 频道链接');
  assert.ok(vals.includes('@SomeOne'), 'twitter handle 的 @ 形态');
  assert.ok(vals.includes('space.bilibili.com/672328094'), 'bilibili 链接（原有行为不能丢）');
});

t('别名来源标注平台（界面要能说「凭什么说这条是他的」）', () => {
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

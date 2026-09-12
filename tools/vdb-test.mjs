// vdb-test.mjs — VDB 提供者与 tar 读取的自检
// 两件最怕的事：① tar 解错（文件名乱码/丢条目 → 花名册静默缺人）；
// ② 匹配只认 bilibili（使用者关注的是 twitch / youtube / twitter 上的人，就搜不到）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parsePax, readTar } from '../server/src/tar.js';
import {
  PLATFORM_URLS,
  buildIndex,
  indexSummary,
  loadCachedIndex,
  membersOfGroup,
  parseRecord,
  searchIndex,
  slug,
  toPerson,
} from '../server/src/vdb.js';

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

/** 造一个 tar 条目（USTAR，含校验和） */
function tarEntry(name, content, type = '0', { prefix = '' } = {}) {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644', 100, 'ascii'); // mode
  header.write('0000000', 108, 'ascii');
  header.write('0000000', 116, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii'); // mtime
  header.write('        ', 148, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  if (prefix) header.write(prefix.slice(0, 155), 345, 'utf8');
  // 校验和：先填空格再算
  header.write('        ', 148, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

const tarOf = (entries) => Buffer.concat([...entries.map((e) => tarEntry(...e)), Buffer.alloc(1024)]);

process.stdout.write('\ntar: 读取\n');

t('普通条目（含 UTF-8 中文名）读出且内容一致', () => {
  const buf = tarOf([['vdb-master/vtbs/嘉然今天吃什么.json', '{"group":"A-SOUL"}']]);
  const files = readTar(buf);
  assert.equal(files.size, 1);
  assert.ok(files.has('vdb-master/vtbs/嘉然今天吃什么.json'), [...files.keys()].join(','));
  assert.equal(files.get('vdb-master/vtbs/嘉然今天吃什么.json').toString('utf8'), '{"group":"A-SOUL"}');
});

t('目录条目不入表；多个条目都在', () => {
  const buf = tarOf([
    ['vdb-master/', '', '5'],
    ['vdb-master/vtbs/a.json', '{"name":{"cn":"甲"}}'],
    ['vdb-master/vtbs/b.json', '{"name":{"cn":"乙"}}'],
  ]);
  const files = readTar(buf);
  assert.equal(files.size, 2, [...files.keys()].join(','));
});

/**
 * 造一条 pax 记录。两个容易写错的点，这里都按标准来：
 *   · 长度字段**包含它自己的位数**；
 *   · 长度按 **UTF-8 字节**算，不是 JS 字符数（中文一个字 3 字节）。
 */
function paxRecord(key, value) {
  const body = Buffer.from(`${key}=${value}\n`, 'utf8');
  let len = body.length + 2; // 最少是「数字 + 空格 + 正文」
  while (String(len).length + 1 + body.length !== len) len = String(len).length + 1 + body.length;
  return Buffer.concat([Buffer.from(`${len} `, 'utf8'), body]);
}

t('pax 扩展头（长路径）：path= 覆盖下一个条目的名字', () => {
  // 真实 git archive 里的 pax path 是**完整路径**（含顶层目录），所以这里也照真实来造
  const longName = 'vdb-master/vtbs/' + '很长的中文名字'.repeat(12) + '.json';
  const buf = tarOf([
    ['PaxHeader/x', paxRecord('path', longName), 'x'],
    ['vdb-master/vtbs/truncated.json', '{"name":{"cn":"长"}}'],
  ]);
  const files = readTar(buf);
  assert.ok(files.has(longName), [...files.keys()].join(','));
  assert.equal(files.get(longName).toString('utf8'), '{"name":{"cn":"长"}}');
});

t('GNU 长名（type L）：下一个条目用它当名字', () => {
  const longName = 'vdb-master/vtbs/' + 'x'.repeat(150) + '.json';
  const buf = tarOf([
    ['././@LongLink', longName, 'L'],
    ['vdb-master/vtbs/short.json', '{}'],
  ]);
  const files = readTar(buf);
  assert.ok(files.has(longName), [...files.keys()].join(','));
});

t('ustar prefix 拼回完整路径', () => {
  const buf = tarOf([['deep.json', '{}', '0', { prefix: 'vdb-master/very/long/dir' }]]);
  const files = readTar(buf);
  assert.ok(files.has('vdb-master/very/long/dir/deep.json'), [...files.keys()].join(','));
});

t('parsePax 解析多条记录', () => {
  const body = '12 path=abc\n10 size=5\n';
  const pax = parsePax(Buffer.from('12 path=abc\n10 size=5\n', 'utf8'));
  assert.equal(pax.path, 'abc');
  assert.equal(pax.size, '5');
  void body;
});

t('空 tar / 截断 tar 不抛错', () => {
  assert.deepEqual([...readTar(Buffer.alloc(1024)).keys()], []);
  assert.deepEqual([...readTar(Buffer.alloc(100)).keys()], []);
});

process.stdout.write('\nvdb: 记录与索引\n');

const RECS = [
  ['嘉然今天吃什么.json', { name: { cn: '嘉然', en: 'Diana' }, accounts: { bilibili: '672328094', weibo: '7595006312' }, group: 'A-SOUL' }],
  ['TokinoSora.json', { name: { jp: 'ときのそら', en: 'Tokino Sora' }, accounts: { youtube: 'UCp6993wxpyDPHUpavwDFqgg', twitter: 'tokino_sora' }, group: 'Hololive' }],
  ['某人.json', { name: { cn: '某个人', extra: ['别名甲'] }, accounts: { twitch: 'someone_tv', tiktok: 'someone' } }],
  ['鹿乃.json', { name: { jp: '鹿乃' }, accounts: { bilibili: '316381099', niconico: '12345' } }],
];
const tarGz = zlib.gzipSync(tarOf(RECS.map(([f, r]) => [`vdb-master/vtbs/${f}`, JSON.stringify(r)])));

t('parseRecord：多语言名字都收进 names，默认语言优先', () => {
  const r = parseRecord({ name: { default: 'en', cn: '甲', en: 'Jia' } }, 'x.json');
  assert.deepEqual(r.names, ['Jia', '甲'], r.names.join(','));
  const noDefault = parseRecord({ name: { en: 'B', cn: '丙' } }, 'x.json');
  assert.deepEqual(noDefault.names, ['丙', 'B'], '没有 default 时按 cn → jp → en');
});

t('parseRecord：accounts 全平台保留，空值丢掉；没有 group 就是 null', () => {
  const r = parseRecord({ name: { cn: '甲' }, accounts: { bilibili: '1', twitch: '', youtube: null } }, 'x.json');
  assert.deepEqual(r.accounts, { bilibili: '1' });
  assert.equal(r.group, null);
});

t('buildIndex：条目数、社团统计、平台统计都对', () => {
  const idx = buildIndex(tarGz);
  assert.equal(idx.count, 4, JSON.stringify(idx).slice(0, 120));
  assert.equal(idx.groups['Hololive'], 1);
  assert.equal(idx.groups['A-SOUL'], 1);
  assert.equal(idx.platforms.bilibili, 2);
  assert.equal(idx.platforms.youtube, 1);
  assert.equal(idx.platforms.twitch, 1);
  assert.equal(idx.source, 'dd-center/vdb');
  assert.match(idx.license, /BY-NC-SA/, '许可要写进索引，界面才能署名');
});

t('buildIndex：坏 JSON 记为 skipped，不影响其它条目', () => {
  const bad = zlib.gzipSync(tarOf([
    ['vdb-master/vtbs/a.json', '{"name":{"cn":"甲"}}'],
    ['vdb-master/vtbs/bad.json', '{ 不是 JSON'],
  ]));
  const idx = buildIndex(bad);
  assert.equal(idx.count, 1);
  assert.equal(idx.skipped, 1);
});

t('只有 vtbs/ 下的 json 被收（docs、config 之类不混进来）', () => {
  const mixed = zlib.gzipSync(tarOf([
    ['vdb-master/vtbs/a.json', '{"name":{"cn":"甲"}}'],
    ['vdb-master/docs/readme.json', '{"name":{"cn":"不是人"}}'],
    ['vdb-master/config/index.js', 'module.exports={}'],
  ]));
  const idx = buildIndex(mixed);
  assert.equal(idx.count, 1);
  assert.deepEqual(idx.records.map((r) => r.names[0]), ['甲']);
});

process.stdout.write('\nvdb: 搜索（多平台，不只 bilibili）\n');

const idx = buildIndex(tarGz);

t('按中文名 / 英文名 / 日文名 / extra 别名都能搜到', () => {
  assert.equal(searchIndex(idx, '嘉然')[0].group, 'A-SOUL');
  assert.equal(searchIndex(idx, 'Diana')[0].names[0], '嘉然');
  assert.equal(searchIndex(idx, 'ときのそら')[0].group, 'Hololive');
  assert.equal(searchIndex(idx, '别名甲')[0].names[0], '某个人');
});

t('**按任意平台账号 id 搜**：twitch / youtube / twitter / niconico 都能命中', () => {
  assert.equal(searchIndex(idx, 'someone_tv')[0].names[0], '某个人', 'twitch 名要能搜');
  assert.equal(searchIndex(idx, 'UCp6993wxpyDPHUpavwDFqgg')[0].names[0], 'ときのそら', 'youtube channel id 要能搜');
  assert.equal(searchIndex(idx, 'tokino_sora')[0].names[0], 'ときのそら', 'twitter handle 要能搜');
  assert.equal(searchIndex(idx, '12345')[0].names[0], '鹿乃', 'niconico id 要能搜');
});

t('按平台链接形态搜（粘贴一个空间/频道链接也能找到）', () => {
  assert.equal(searchIndex(idx, 'space.bilibili.com/316381099')[0].names[0], '鹿乃');
  assert.equal(searchIndex(idx, 'twitch.tv/someone_tv')[0].names[0], '某个人');
});

t('按社团过滤；结果带 score 且精确匹配排前', () => {
  const inBox = searchIndex(idx, 'o', { group: 'Hololive' });
  assert.ok(inBox.every((r) => r.group === 'Hololive'));
  const exact = searchIndex(idx, '嘉然');
  assert.equal(exact[0].score, 100);
});

t('搜不到就返回空数组（不抛错）', () => {
  assert.deepEqual(searchIndex(idx, '不存在的人xyz'), []);
  assert.deepEqual(searchIndex({ records: [] }, 'x'), []);
});

t('membersOfGroup 取整箱成员', () => {
  assert.deepEqual(membersOfGroup(idx, 'Hololive').map((r) => r.names[0]), ['ときのそら']);
  assert.deepEqual(membersOfGroup(idx, '没有这个箱'), []);
});

t('索引摘要能读', () => {
  assert.match(indexSummary(idx), /4 位（社团 2 个）/);
  assert.match(indexSummary(null), /尚未获取/);
});

process.stdout.write('\nvdb: 转成关注对象（平台无关）\n');

t('toPerson：名字/别名/社团/链接都带过去，链接**不限于 bilibili**', () => {
  const p = toPerson(idx.records.find((r) => r.names[0] === 'ときのそら'));
  assert.equal(p.name, 'ときのそら');
  assert.equal(p.agency, 'Hololive');
  assert.deepEqual(p.aliases, ['Tokino Sora']);
  assert.equal(p.links.youtube, 'UCp6993wxpyDPHUpavwDFqgg');
  assert.equal(p.links.twitter, 'tokino_sora');
  assert.equal(p.id, 'TokinoSora');
});

t('toPerson：社团为空时给空串（界面按空处理），并留下 VDB 溯源信息', () => {
  const p = toPerson(idx.records.find((r) => r.names[0] === '某个人'));
  assert.equal(p.agency, '');
  assert.equal(p._vdb.key, '某人');
  assert.equal(p.links.twitch, 'someone_tv');
});

t('slug 稳定、去掉文件系统不友好字符', () => {
  assert.equal(slug('嘉然今天吃什么'), '嘉然今天吃什么');
  assert.equal(slug('a/b\\c:d'), 'a_b_c_d');
  assert.equal(slug(''), 'vdb-' + slug('').slice(4), '空名字也要给一个 id');
});

t('PLATFORM_URLS 覆盖 VDB 实际出现的平台（漏了就会搜不到链接形态）', () => {
  for (const p of ['bilibili', 'youtube', 'youtubeAt', 'twitter', 'twitch', 'tiktok', 'weibo', 'acfun', 'niconico', 'showroom', 'pixiv', 'afdian', 'ci-en', 'booth', 'fantia', 'marshmallow', 'userlocal', 'instagram', 'telegram', 'patreon', 'peing', '163music']) {
    assert.ok(PLATFORM_URLS[p], '缺平台链接模板: ' + p);
  }
});

process.stdout.write('\nvdb: 缓存\n');

t('loadCachedIndex：没有缓存返回 null，不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-vdb-'));
  const cfg = { paths: { feedsDir: dir } };
  assert.equal(loadCachedIndex(cfg), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 用**真实的** VDB tarball 对账（本地有缓存才跑）：这才是「解包解对了」的硬证据。
// 合成用例能测分支，但测不出「真实包里到底用的哪种长名/编码」。
const realTgz = process.env.VML_VDB_TARBALL || path.join(os.tmpdir(), 'vdb.tar.gz');
if (fs.existsSync(realTgz)) {
  t('真实 tarball：条目数、UTF-8 文件名、抽样内容都与上游 raw 一致', () => {
    const real = buildIndex(fs.readFileSync(realTgz));
    assert.ok(real.count > 9000, '真实库应有近万条，实际 ' + real.count);
    assert.ok(Object.keys(real.groups).length > 150, '社团数 ' + Object.keys(real.groups).length);
    assert.ok(real.platforms.bilibili > 9000);
    // 文件名不能有替换字符（tar.exe 在 Windows 上会解成乱码，这里必须不是）
    const mojibake = real.records.filter((r) => r.key.includes('\uFFFD'));
    assert.equal(mojibake.length, 0, '有乱码文件名: ' + mojibake.slice(0, 3).map((r) => r.key).join(','));
    // 抽一条和上游 raw 内容对账
    const jaran = real.records.find((r) => r.key === '嘉然今天吃什么');
    assert.ok(jaran, '应有「嘉然今天吃什么」');
    assert.equal(jaran.group, 'A-SOUL');
    assert.equal(jaran.accounts.bilibili, '672328094');
    assert.deepEqual(jaran.names, ['嘉然', 'Diana']);
  });
} else {
  process.stdout.write('  [skip] 真实 tarball（设 VML_VDB_TARBALL 指向一个 vdb tar.gz 就会跑这条）\n');
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

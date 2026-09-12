// vdb-test.mjs — self-check for the VDB provider and tar reading
// The two things we fear most: (1) tar decoded wrongly (garbled filenames / dropped entries -> the roster
// silently loses people); (2) matching that only knows bilibili (the people the user actually follows live on
// twitch / youtube / twitter and are then unsearchable).
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

/** Build one tar entry (USTAR, checksum included) */
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
  // Checksum: fill in spaces first, then compute
  header.write('        ', 148, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

const tarOf = (entries) => Buffer.concat([...entries.map((e) => tarEntry(...e)), Buffer.alloc(1024)]);

process.stdout.write('\ntar: reading\n');

t('a plain entry (with a UTF-8 Chinese filename) reads back with identical content', () => {
  const buf = tarOf([['vdb-master/vtbs/嘉然今天吃什么.json', '{"group":"A-SOUL"}']]);
  const files = readTar(buf);
  assert.equal(files.size, 1);
  assert.ok(files.has('vdb-master/vtbs/嘉然今天吃什么.json'), [...files.keys()].join(','));
  assert.equal(files.get('vdb-master/vtbs/嘉然今天吃什么.json').toString('utf8'), '{"group":"A-SOUL"}');
});

t('directory entries never enter the table; multiple entries are all there', () => {
  const buf = tarOf([
    ['vdb-master/', '', '5'],
    ['vdb-master/vtbs/a.json', '{"name":{"cn":"甲"}}'],
    ['vdb-master/vtbs/b.json', '{"name":{"cn":"乙"}}'],
  ]);
  const files = readTar(buf);
  assert.equal(files.size, 2, [...files.keys()].join(','));
});

/**
 * Build one pax record. Two points that are easy to get wrong, both done per the standard here:
 *   - the length field **includes its own digits**;
 *   - the length counts **UTF-8 bytes**, not JS characters (one Chinese character is 3 bytes).
 */
function paxRecord(key, value) {
  const body = Buffer.from(`${key}=${value}\n`, 'utf8');
  let len = body.length + 2; // the minimum is "digits + space + body"
  while (String(len).length + 1 + body.length !== len) len = String(len).length + 1 + body.length;
  return Buffer.concat([Buffer.from(`${len} `, 'utf8'), body]);
}

t('pax extended header (long path): path= overrides the next entry name', () => {
  // In a real git archive the pax path is the **full path** (including the top-level directory), so we build it the real way here
  const longName = 'vdb-master/vtbs/' + '很长的中文名字'.repeat(12) + '.json';
  const buf = tarOf([
    ['PaxHeader/x', paxRecord('path', longName), 'x'],
    ['vdb-master/vtbs/truncated.json', '{"name":{"cn":"长"}}'],
  ]);
  const files = readTar(buf);
  assert.ok(files.has(longName), [...files.keys()].join(','));
  assert.equal(files.get(longName).toString('utf8'), '{"name":{"cn":"长"}}');
});

t('GNU long name (type L): the next entry takes it as its name', () => {
  const longName = 'vdb-master/vtbs/' + 'x'.repeat(150) + '.json';
  const buf = tarOf([
    ['././@LongLink', longName, 'L'],
    ['vdb-master/vtbs/short.json', '{}'],
  ]);
  const files = readTar(buf);
  assert.ok(files.has(longName), [...files.keys()].join(','));
});

t('the ustar prefix is joined back into the full path', () => {
  const buf = tarOf([['deep.json', '{}', '0', { prefix: 'vdb-master/very/long/dir' }]]);
  const files = readTar(buf);
  assert.ok(files.has('vdb-master/very/long/dir/deep.json'), [...files.keys()].join(','));
});

t('parsePax parses several records', () => {
  const body = '12 path=abc\n10 size=5\n';
  const pax = parsePax(Buffer.from('12 path=abc\n10 size=5\n', 'utf8'));
  assert.equal(pax.path, 'abc');
  assert.equal(pax.size, '5');
  void body;
});

t('an empty tar / a truncated tar does not throw', () => {
  assert.deepEqual([...readTar(Buffer.alloc(1024)).keys()], []);
  assert.deepEqual([...readTar(Buffer.alloc(100)).keys()], []);
});

process.stdout.write('\nvdb: records and index\n');

const RECS = [
  ['嘉然今天吃什么.json', { name: { cn: '嘉然', en: 'Diana' }, accounts: { bilibili: '672328094', weibo: '7595006312' }, group: 'A-SOUL' }],
  ['TokinoSora.json', { name: { jp: 'ときのそら', en: 'Tokino Sora' }, accounts: { youtube: 'UCp6993wxpyDPHUpavwDFqgg', twitter: 'tokino_sora' }, group: 'Hololive' }],
  ['某人.json', { name: { cn: '某个人', extra: ['别名甲'] }, accounts: { twitch: 'someone_tv', tiktok: 'someone' } }],
  ['鹿乃.json', { name: { jp: '鹿乃' }, accounts: { bilibili: '316381099', niconico: '12345' } }],
];
const tarGz = zlib.gzipSync(tarOf(RECS.map(([f, r]) => [`vdb-master/vtbs/${f}`, JSON.stringify(r)])));

t('parseRecord: every language name lands in names, default language first', () => {
  const r = parseRecord({ name: { default: 'en', cn: '甲', en: 'Jia' } }, 'x.json');
  assert.deepEqual(r.names, ['Jia', '甲'], r.names.join(','));
  const noDefault = parseRecord({ name: { en: 'B', cn: '丙' } }, 'x.json');
  assert.deepEqual(noDefault.names, ['丙', 'B'], 'with no default it goes cn -> jp -> en');
});

t('parseRecord: accounts are kept for every platform and empty values dropped; no group means null', () => {
  const r = parseRecord({ name: { cn: '甲' }, accounts: { bilibili: '1', twitch: '', youtube: null } }, 'x.json');
  assert.deepEqual(r.accounts, { bilibili: '1' });
  assert.equal(r.group, null);
});

t('buildIndex: entry count, group stats and platform stats all line up', () => {
  const idx = buildIndex(tarGz);
  assert.equal(idx.count, 4, JSON.stringify(idx).slice(0, 120));
  assert.equal(idx.groups['Hololive'], 1);
  assert.equal(idx.groups['A-SOUL'], 1);
  assert.equal(idx.platforms.bilibili, 2);
  assert.equal(idx.platforms.youtube, 1);
  assert.equal(idx.platforms.twitch, 1);
  assert.equal(idx.source, 'dd-center/vdb');
  assert.match(idx.license, /BY-NC-SA/, 'the license must go into the index so the UI can credit it');
});

t('buildIndex: a bad JSON is counted as skipped and does not affect other entries', () => {
  const bad = zlib.gzipSync(tarOf([
    ['vdb-master/vtbs/a.json', '{"name":{"cn":"甲"}}'],
    ['vdb-master/vtbs/bad.json', '{ 不是 JSON'],
  ]));
  const idx = buildIndex(bad);
  assert.equal(idx.count, 1);
  assert.equal(idx.skipped, 1);
});

t('only the json under vtbs/ is collected (docs, config and the like never mix in)', () => {
  const mixed = zlib.gzipSync(tarOf([
    ['vdb-master/vtbs/a.json', '{"name":{"cn":"甲"}}'],
    ['vdb-master/docs/readme.json', '{"name":{"cn":"不是人"}}'],
    ['vdb-master/config/index.js', 'module.exports={}'],
  ]));
  const idx = buildIndex(mixed);
  assert.equal(idx.count, 1);
  assert.deepEqual(idx.records.map((r) => r.names[0]), ['甲']);
});

process.stdout.write('\nvdb: search (multi-platform, not just bilibili)\n');

const idx = buildIndex(tarGz);

t('searchable by Chinese name / English name / Japanese name / extra alias', () => {
  assert.equal(searchIndex(idx, '嘉然')[0].group, 'A-SOUL');
  assert.equal(searchIndex(idx, 'Diana')[0].names[0], '嘉然');
  assert.equal(searchIndex(idx, 'ときのそら')[0].group, 'Hololive');
  assert.equal(searchIndex(idx, '别名甲')[0].names[0], '某个人');
});

t('**searchable by any platform account id**: twitch / youtube / twitter / niconico all hit', () => {
  assert.equal(searchIndex(idx, 'someone_tv')[0].names[0], '某个人', 'a twitch name must be searchable');
  assert.equal(searchIndex(idx, 'UCp6993wxpyDPHUpavwDFqgg')[0].names[0], 'ときのそら', 'a youtube channel id must be searchable');
  assert.equal(searchIndex(idx, 'tokino_sora')[0].names[0], 'ときのそら', 'a twitter handle must be searchable');
  assert.equal(searchIndex(idx, '12345')[0].names[0], '鹿乃', 'a niconico id must be searchable');
});

t('searchable by platform link shape (pasting a space/channel link finds them too)', () => {
  assert.equal(searchIndex(idx, 'space.bilibili.com/316381099')[0].names[0], '鹿乃');
  assert.equal(searchIndex(idx, 'twitch.tv/someone_tv')[0].names[0], '某个人');
});

t('filter by group; results carry a score and the exact match ranks first', () => {
  const inBox = searchIndex(idx, 'o', { group: 'Hololive' });
  assert.ok(inBox.every((r) => r.group === 'Hololive'));
  const exact = searchIndex(idx, '嘉然');
  assert.equal(exact[0].score, 100);
});

t('no hit returns an empty array (rather than throwing)', () => {
  assert.deepEqual(searchIndex(idx, '不存在的人xyz'), []);
  assert.deepEqual(searchIndex({ records: [] }, 'x'), []);
});

t('membersOfGroup returns every member of one group', () => {
  assert.deepEqual(membersOfGroup(idx, 'Hololive').map((r) => r.names[0]), ['ときのそら']);
  assert.deepEqual(membersOfGroup(idx, '没有这个箱'), []);
});

t('the index summary is readable', () => {
  assert.match(indexSummary(idx), /4 位（社团 2 个）/);
  assert.match(indexSummary(null), /尚未获取/);
});

process.stdout.write('\nvdb: converting to watch targets (platform-agnostic)\n');

t('toPerson: name/aliases/group/links all come across, and links are **not limited to bilibili**', () => {
  const p = toPerson(idx.records.find((r) => r.names[0] === 'ときのそら'));
  assert.equal(p.name, 'ときのそら');
  assert.equal(p.agency, 'Hololive');
  assert.deepEqual(p.aliases, ['Tokino Sora']);
  assert.equal(p.links.youtube, 'UCp6993wxpyDPHUpavwDFqgg');
  assert.equal(p.links.twitter, 'tokino_sora');
  assert.equal(p.id, 'TokinoSora');
});

t('toPerson: an empty group becomes an empty string (the UI treats it as empty), and the VDB provenance stays', () => {
  const p = toPerson(idx.records.find((r) => r.names[0] === '某个人'));
  assert.equal(p.agency, '');
  assert.equal(p._vdb.key, '某人');
  assert.equal(p.links.twitch, 'someone_tv');
});

t('slug is stable and strips characters the filesystem dislikes', () => {
  assert.equal(slug('嘉然今天吃什么'), '嘉然今天吃什么');
  assert.equal(slug('a/b\\c:d'), 'a_b_c_d');
  // Stability means "same name -> same id", which is what keeps re-importing from creating
  // duplicates. The empty-name fallback is deliberately NOT stable — it goes through
  // `vdb-${Date.now().toString(36)}` so that two unnamed records do not collide — so assert its
  // *shape* here. (This used to compare two independent calls and flaked whenever they straddled
  // a millisecond boundary: `vdb-mtyq6d3c` vs `vdb-mtyq6d3d`. See BUGS #66.)
  const unnamed = slug('');
  assert.ok(/^vdb-[a-z0-9]+$/.test(unnamed), 'an empty name still needs a generated id: ' + unnamed);
  assert.equal(slug('嘉然今天吃什么'), slug('嘉然今天吃什么'), 'the same name must always give the same id');
});

t('PLATFORM_URLS covers the platforms that actually occur in VDB (a missing one makes link shapes unsearchable)', () => {
  for (const p of ['bilibili', 'youtube', 'youtubeAt', 'twitter', 'twitch', 'tiktok', 'weibo', 'acfun', 'niconico', 'showroom', 'pixiv', 'afdian', 'ci-en', 'booth', 'fantia', 'marshmallow', 'userlocal', 'instagram', 'telegram', 'patreon', 'peing', '163music']) {
    assert.ok(PLATFORM_URLS[p], 'missing platform link template: ' + p);
  }
});

process.stdout.write('\nvdb: cache\n');

t('loadCachedIndex: with no cache it returns null and does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-vdb-'));
  const cfg = { paths: { feedsDir: dir } };
  assert.equal(loadCachedIndex(cfg), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Reconcile against the **real** VDB tarball (only runs when a local cache exists): that is the hard evidence
// that "unpacking is correct". Synthetic cases exercise the branches, but they cannot tell you which long-name
// or encoding form the real archive actually uses.
const realTgz = process.env.VML_VDB_TARBALL || path.join(os.tmpdir(), 'vdb.tar.gz');
if (fs.existsSync(realTgz)) {
  t('real tarball: entry count, UTF-8 filenames and sampled content all match the upstream raw files', () => {
    const real = buildIndex(fs.readFileSync(realTgz));
    assert.ok(real.count > 9000, 'the real roster should hold nearly ten thousand entries, got ' + real.count);
    assert.ok(Object.keys(real.groups).length > 150, 'group count ' + Object.keys(real.groups).length);
    assert.ok(real.platforms.bilibili > 9000);
    // Filenames must not contain the replacement character (tar.exe decodes them as mojibake on Windows, so it must not be that here)
    const mojibake = real.records.filter((r) => r.key.includes('\uFFFD'));
    assert.equal(mojibake.length, 0, 'mojibake filenames present: ' + mojibake.slice(0, 3).map((r) => r.key).join(','));
    // Sample one entry and reconcile it against the upstream raw content
    const jaran = real.records.find((r) => r.key === '嘉然今天吃什么');
    assert.ok(jaran, 'there should be an entry named "嘉然今天吃什么"');
    assert.equal(jaran.group, 'A-SOUL');
    assert.equal(jaran.accounts.bilibili, '672328094');
    assert.deepEqual(jaran.names, ['嘉然', 'Diana']);
  });
} else {
  process.stdout.write('  [skip] real tarball (point VML_VDB_TARBALL at a vdb tar.gz and this one runs)\n');
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

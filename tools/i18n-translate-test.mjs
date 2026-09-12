// i18n-translate-test.mjs — 翻译管线的自检 / self-test for the translation pipeline
//
// 管线里最贵的错误是「安静地写坏数据」：把占位符翻没了、把术语翻乱了、
// 拿机器译文覆盖了人工校对过的内容。所以这些都要有断言，而且用假引擎跑（不花钱）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheKey, humanKeys, needsRetranslate, protect, restore } from './i18n-translate.mjs';

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

process.stdout.write('\ni18n-translate: 占位符保护\n');
t('{} / ${} / %s / 换行 / 日期形态都被替换成哨兵', () => {
  const { text, tokens } = protect('确认发到「{target}」？${x} %s\\n 格式 MM-DD 与 12-31');
  assert.ok(!text.includes('{target}'), '花括号占位符必须被保护: ' + text);
  assert.ok(!text.includes('${x}'));
  assert.ok(!text.includes('%s'));
  assert.ok(text.includes('⟦'), '应该有哨兵');
  assert.ok(tokens.length >= 5, 'token 数: ' + tokens.length);
});

t('还原后与原文一致（往返无损）', () => {
  const src = '确认发到「{target}」？\\n 日期 MM-DD 结束';
  const { text, tokens } = protect(src);
  const back = restore(text.replace(/⟦(\d+)⟧/g, (m) => m), tokens);
  assert.equal(back.text, src);
  assert.equal(back.ok, true);
});

t('哨兵被模型弄丢 → 判失败（宁缺勿坏）', () => {
  const { tokens } = protect('确认发到「{target}」？');
  const r = restore('Confirm sending to (nothing)?', tokens);
  assert.equal(r.ok, false, '缺哨兵必须判失败');
  assert.equal(r.missing.length, 1);
});

t('模型把方括号写成圆括号也能容错还原', () => {
  const { tokens } = protect('发送到「{target}」');
  const r = restore('Send to ( 0 )?', tokens);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Send to {target}?');
});

process.stdout.write('\ni18n-translate: 术语表\n');
t('术语被锁死：模型拿不到它，也就改不动它', () => {
  const glossary = { 情报: { 'ja-JP': 'インテリジェンス' } };
  const { text, tokens } = protect('情报卡片流', glossary, 'ja-JP');
  assert.ok(!text.includes('情报'), '术语应先被替换掉: ' + text);
  const back = restore(text, tokens);
  assert.equal(back.text, 'インテリジェンス卡片流');
});

t('没有该语言的术语时退回 default', () => {
  const glossary = { 嘉然: { default: 'Diana' } };
  const { text, tokens } = protect('嘉然 3D披露', glossary, 'ko-KR');
  assert.equal(restore(text, tokens).text, 'Diana 3D披露');
});

t('长术语优先（避免短词把长词切碎）', () => {
  const glossary = { 情报: { default: 'I' }, 情报卡片: { default: 'IC' } };
  const { text, tokens } = protect('情报卡片', glossary, 'ja-JP');
  assert.equal(restore(text, tokens).text, 'IC', '应当整体匹配长术语');
});

process.stdout.write('\ni18n-translate: 缓存键\n');
t('键 = 源串 + 目标语言（换语言要重译，改源串是新键）', () => {
  const a = cacheKey('情报', 'ja-JP');
  const b = cacheKey('情报', 'ko-KR');
  const c = cacheKey('情报 ', 'ja-JP');
  assert.notEqual(a, b, '不同语言不能共用译文');
  assert.notEqual(a, c, '源串变了就是新键');
  assert.equal(a, cacheKey('情报', 'ja-JP'), '同源同语言必须稳定');
});

process.stdout.write('\ni18n-translate: 层级（人工永远压过机器）\n');
t('人工词条被识别出来，机器层不得覆盖', () => {
  const ja = humanKeys('ja-JP');
  assert.ok(ja.has('save'), 'save 是人工写的');
  assert.ok(ja.has('tab_intel'), 'tab_intel 是人工写的');
  assert.ok(!ja.has('__nonexistent__'));
});

t('同语言的地区继承也算人工（es-MX 复用 es-ES 的人工词条）', () => {
  const mx = humanKeys('es-MX');
  assert.ok(mx.has('save'), 'es-ES 的 save 应当也算 es-MX 的人工层');
});

process.stdout.write('\ni18n-translate: 端到端（假引擎）\n');
t('假引擎跑通：只翻缺失的键、人工层不被覆盖、缓存能复用', () => {
  // 沙箱：缓存与产物都指到临时目录 —— 否则真实翻译填满缓存之后，
  // 「第一次应当新译 6 条」这种断言会被缓存命中打败（踩过：真翻译跑完后这条就红了）
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-i18n-'));
  const common = ['--engine', 'mock', '--locales', 'ja-JP', '--limit', '6', '--cache-dir', sandbox, '--out', path.join(sandbox, 'machine.json')];
  const out1 = execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), ...common], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(/新译 6/.test(out1), out1);
  const machine = JSON.parse(fs.readFileSync(path.join(sandbox, 'machine.json'), 'utf8'));
  const ja = machine['ja-JP'] ?? {};
  assert.ok(Object.keys(ja).length >= 6, '应当写入条目');
  assert.ok(Object.values(ja).some((v) => v.startsWith('【JA】')), '假引擎的标记应当在');
  assert.ok(!('save' in ja), 'save 是人工词条，机器层不该有它（人工永远压过机器）');

  // 第二次：刚翻过的那批必须走缓存（「同一句永不重复花钱」），同时继续往下翻新的一批
  const out2 = execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), ...common], { cwd: ROOT, encoding: 'utf8' });
  const cached = Number(/缓存命中 (\d+)/.exec(out2)?.[1] ?? 0);
  assert.ok(cached >= 6, `第二次应当至少命中 6 条缓存，实际 ${cached}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

t('--bust terms 的判据：含专有名词才重译（纯逻辑，按单元测而不是跑命令行）', () => {
  const glossary = { Telegram: { default: 'Telegram' } };
  // none：永远走缓存
  assert.equal(needsRetranslate('Telegram 推送失败', 'none', glossary), false);
  // all：全部重译
  assert.equal(needsRetranslate('保存', 'all', glossary), true);
  // terms：命中术语表 或 含「像品牌名的大写拉丁片段」才重译
  assert.equal(needsRetranslate('Telegram 推送失败', 'terms', glossary), true);
  assert.equal(needsRetranslate('Bark 的 key', 'terms', glossary), true);
  assert.equal(needsRetranslate('SQLite 归档', 'terms', glossary), true);
  assert.equal(needsRetranslate('保存', 'terms', glossary), false, '纯中文标签不该被重译');
  assert.equal(needsRetranslate('今天', 'terms', glossary), false);
  assert.equal(needsRetranslate('把情报打成一个单文件发给朋友', 'terms', glossary), false);
});

t('缓存文件里没有密钥之类的东西（只有源串哈希 → 译文）', () => {
  const cachePath = path.join(ROOT, 'web/src/locales/.cache/ja-JP.json');
  if (!fs.existsSync(cachePath)) return;
  const raw = fs.readFileSync(cachePath, 'utf8');
  assert.ok(!/sk-|apiKey|Bearer/i.test(raw), '缓存不该含任何凭据');
  const obj = JSON.parse(raw);
  for (const k of Object.keys(obj)) assert.match(k, /^[0-9a-f]{20}$/);
});

t('没有 --locales 时给出用法并退出 2（不会误跑）', () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), '--engine', 'mock'], { cwd: ROOT, encoding: 'utf8' });
    assert.fail('应当以非零码退出');
  } catch (e) {
    assert.equal(e.status, 2, '退出码应为 2');
  }
});

t('openai 引擎缺 url/key 时拒绝运行（不拿空 key 去调）', () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), '--engine', 'openai', '--locales', 'ja-JP'], { cwd: ROOT, encoding: 'utf8' });
    assert.fail('应当以非零码退出');
  } catch (e) {
    assert.equal(e.status, 2);
  }
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

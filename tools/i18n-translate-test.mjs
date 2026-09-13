// i18n-translate-test.mjs - self-test for the translation pipeline
//
// The most expensive mistake in this pipeline is silently corrupting data: dropping a
// placeholder, scrambling terminology, or overwriting human-proofread text with machine
// output. So each of those cases gets an assertion, and they all run against a fake
// engine (free).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheKey, humanKeys, isLanguageNeutral, looksUntranslated, needsRetranslate, protect, restore } from './i18n-translate.mjs';
import { readDicts, usedKeys } from './lib/i18n-source.mjs';
import { inheritableAncestors } from './lib/locale-chain.mjs';

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

process.stdout.write('\ni18n-translate: placeholder protection\n');
t('{} / ${} / %s / newlines / date shapes are all replaced by sentinels', () => {
  const { text, tokens } = protect('确认发到「{target}」？${x} %s\\n 格式 MM-DD 与 12-31');
  assert.ok(!text.includes('{target}'), 'brace placeholders must be protected: ' + text);
  assert.ok(!text.includes('${x}'));
  assert.ok(!text.includes('%s'));
  assert.ok(text.includes('⟦'), 'a sentinel is expected');
  assert.ok(tokens.length >= 5, 'token count: ' + tokens.length);
});

t('restoring yields the original text (lossless round-trip)', () => {
  const src = '确认发到「{target}」？\\n 日期 MM-DD 结束';
  const { text, tokens } = protect(src);
  const back = restore(text.replace(/⟦(\d+)⟧/g, (m) => m), tokens);
  assert.equal(back.text, src);
  assert.equal(back.ok, true);
});

t('a sentinel the model lost -> reported as a failure (better to fail than to emit a broken string)', () => {
  const { tokens } = protect('确认发到「{target}」？');
  const r = restore('Confirm sending to (nothing)?', tokens);
  assert.equal(r.ok, false, 'a missing sentinel must count as failure');
  assert.equal(r.missing.length, 1);
});

t('brackets the model rewrote as parentheses still restore tolerantly', () => {
  const { tokens } = protect('发送到「{target}」');
  const r = restore('Send to ( 0 )?', tokens);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Send to {target}?');
});

process.stdout.write('\ni18n-translate: glossary\n');
t('terms are substituted out: the model never sees them, so it cannot alter them', () => {
  const glossary = { 情报: { 'ja-JP': 'インテリジェンス' } };
  const { text, tokens } = protect('情报卡片流', glossary, 'ja-JP');
  assert.ok(!text.includes('情报'), 'terms must be substituted first: ' + text);
  const back = restore(text, tokens);
  assert.equal(back.text, 'インテリジェンス卡片流');
});

t('falls back to default when the term has no entry for that language', () => {
  const glossary = { 嘉然: { default: 'Diana' } };
  const { text, tokens } = protect('嘉然 3D披露', glossary, 'ko-KR');
  assert.equal(restore(text, tokens).text, 'Diana 3D披露');
});

t('longer terms win (a short term must not split a longer one)', () => {
  const glossary = { 情报: { default: 'I' }, 情报卡片: { default: 'IC' } };
  const { text, tokens } = protect('情报卡片', glossary, 'ja-JP');
  assert.equal(restore(text, tokens).text, 'IC', 'the long term must be matched as a whole');
});

process.stdout.write('\ni18n-translate: cache keys\n');
t('key = source string + target language (a new language re-translates, an edited source is a new key)', () => {
  const a = cacheKey('情报', 'ja-JP');
  const b = cacheKey('情报', 'ko-KR');
  const c = cacheKey('情报 ', 'ja-JP');
  assert.notEqual(a, b, 'different languages must not share a translation');
  assert.notEqual(a, c, 'an edited source string is a new key');
  assert.equal(a, cacheKey('情报', 'ja-JP'), 'same source and language must be stable');
});

process.stdout.write('\ni18n-translate: layers (human always beats machine)\n');
t('human entries are recognized and the machine layer must not overwrite them', () => {
  const ja = humanKeys('ja-JP');
  assert.ok(ja.has('save'), 'save is human-written');
  assert.ok(ja.has('tab_intel'), 'tab_intel is human-written');
  assert.ok(!ja.has('__nonexistent__'));
});

t('regional inheritance within one language counts as human too (es-MX reuses es-ES human entries)', () => {
  const mx = humanKeys('es-MX');
  assert.ok(mx.has('save'), 'save from es-ES must also count as a human entry for es-MX');
});

t('sibling regions do NOT count as human: pt-PT must not block machine translation via pt-BR entries', () => {
  // A trap we already hit: humanKeys used to count every region of the same base as human,
  // so any entry written for pt-BR made pt-PT untranslatable forever - yet pt-PT's chain is
  // ['pt-PT','en-US'], it cannot inherit from pt-BR at runtime, so those 4 entries kept
  // falling back to English while the coverage table still showed 100% (the gap was eaten
  // by the counting rule).
  const ptbr = humanKeys('pt-BR');
  const ptpt = humanKeys('pt-PT');
  assert.ok(ptbr.has('probe'), 'pt-BR itself must have probe (proof that it really is human-written)');
  assert.ok(!ptpt.has('probe'), 'pt-PT must not treat the pt-BR probe as already human (or it never gets translated)');
  assert.ok(ptbr.has('probe'), "pt-BR's own entry still counts as human");
  // The inheritance chain itself: real ancestors inherit, siblings do not (we assert the chain
  // directly here rather than relying on which languages happen to have a human layer).
  // The order is base -> specific: the frontend merges forward in that order, and later (more
  // specific) entries override earlier ones.
  assert.deepEqual(inheritableAncestors('zh-TW'), ['zh', 'zh-Hans', 'zh-Hant']);
  assert.deepEqual(inheritableAncestors('pt-BR'), ['pt-PT']);
  assert.deepEqual(inheritableAncestors('pt-PT'), [], 'pt-PT does not inherit from pt-BR');
  assert.deepEqual(inheritableAncestors('uk-UA'), [], 'uk does not inherit ru (cross-language fallback is English, Russian is not treated as Ukrainian)');
  assert.deepEqual(inheritableAncestors('es-MX'), ['es-ES', 'es-419']);
});

process.stdout.write('\ni18n-translate: dictionary parsing (all four source shapes must be handled)\n');
t('double quotes, multi-line concatenation and nested objects all parse correctly', () => {
  const sample = [
    'const STRINGS = {',
    '  zh: {',
    '    appTitle: "Vtuber\'s Monitor Link",',
    '    loginHint:',
    "      '第一段。' +",
    "      '第二段。' +",
    "      '第三段。',",
    "    nested: {",
    "      inner: '不该被算成外层值',",
    '    },',
    "    after: '后面的词条不能被吃掉',",
    '  },',
    '};',
  ].join('\n');
  const { zh } = readDicts(sample);
  assert.equal(zh.get('appTitle'), "Vtuber's Monitor Link", 'a double-quoted value must be read');
  assert.equal(zh.get('loginHint'), '第一段。第二段。第三段。', 'a multi-line concatenated value must be joined');
  assert.equal(zh.get('nested'), '', 'a nested object is not a string entry');
  assert.equal(zh.get('after'), '后面的词条不能被吃掉', 'a nested object must not swallow the lines after it');
});

t('quotes inside comments are not treated as values (and get cleaned up after import)', () => {
  const sample = ['const STRINGS = {', '  zh: {', "    key: '值', // 备注里写 'x' 不算", '  },', '};'].join('\n');
  const { zh } = readDicts(sample);
  assert.equal(zh.get('key'), '值');
});

t('language-neutral entries (zh source = en) must not waste a translation call', () => {
  assert.equal(isLanguageNeutral('LLM', 'LLM'), true);
  assert.equal(isLanguageNeutral('API Key', 'API Key'), true);
  assert.equal(isLanguageNeutral('保存', 'Save'), false);
  assert.equal(isLanguageNeutral('', ''), false, 'an empty value is not "neutral", it means parsing failed');
  // Such entries really do exist in the shipped dictionaries (otherwise this rule would be a no-op)
  const { zh, en } = readDicts();
  const neutral = [...usedKeys()].filter((k) => isLanguageNeutral(zh.get(k), en.get(k)));
  assert.ok(neutral.length >= 3, 'the real dictionaries must hold at least 3 language-neutral entries, got ' + neutral.length);
});

t('keep-as-is terms must be stripped longest-first', () => {
  // The glossary holds a short term and a longer term that starts with it: stripping the short
  // term first splits the long one apart, so legitimately preserved proper nouns were reported
  // as untranslated (a real trap: 24 of the 37 reported items were false alarms from exactly this).
  const glossary = { 嘉然: { default: '嘉然' }, 嘉然今天吃什么: { default: '嘉然今天吃什么' } };
  assert.equal(
    looksUntranslated('Séparés par des virgules, ex. : 嘉然今天吃什么, Jia Ran', 'fr-FR', glossary),
    false,
    'the long term was stripped correctly, so this must not count as untranslated',
  );
  // But a genuine miss must still be caught
  assert.equal(looksUntranslated('同一件事被各소스分别报道的原文', 'ko-KR', glossary), true);
  assert.equal(looksUntranslated('日本語の漢字は正常', 'ja-JP', glossary), false, 'Japanese is the exception');
});

process.stdout.write('\ni18n-translate: end-to-end (fake engine)\n');
t('fake engine end-to-end: only missing keys are translated, the human layer survives, the cache is reused', () => {
  // Sandbox: point both the cache and the output at a temp dir - otherwise, once real
  // translations fill the cache, assertions like "the first run translates 6 entries" are
  // defeated by cache hits (a trap we hit: this check went red right after a real run)
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-i18n-'));
  const common = ['--engine', 'mock', '--locales', 'ja-JP', '--limit', '6', '--cache-dir', sandbox, '--out', path.join(sandbox, 'machine.json')];
  const out1 = execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), ...common], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(/translated 6/.test(out1), out1);
  const machine = JSON.parse(fs.readFileSync(path.join(sandbox, 'machine.json'), 'utf8'));
  const ja = machine['ja-JP'] ?? {};
  assert.ok(Object.keys(ja).length >= 6, 'entries are expected to be written');
  assert.ok(Object.values(ja).some((v) => v.startsWith('【JA】')), "the fake engine's marker must be there");
  assert.ok(!('save' in ja), 'save is a human entry, the machine layer must not have it (human always beats machine)');

  // Second run: the batch just translated must come from the cache ("never pay twice for the same
  // sentence"), while the next batch keeps getting translated
  const out2 = execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), ...common], { cwd: ROOT, encoding: 'utf8' });
  const cached = Number(/cache hits (\d+)/.exec(out2)?.[1] ?? 0);
  assert.ok(cached >= 6, `the second run must hit at least 6 cache entries, got ${cached}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

t('model echoes the source -> one retry, still invalid means it is NOT written (English fallback wins)', () => {
  // This maps to a real incident: whole Chinese sentences showed up in the Korean UI (6 entries
  // for ko-KR), and because they "had a value", coverage still reported 100%. Now: after one
  // retry with a different prompt (so the model does not just repeat itself), any remaining Han
  // characters are discarded and counted, and the UI falls back to English.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-i18n-echo-'));
  const outFile = path.join(sandbox, 'machine.json');
  const out = execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'tools/i18n-translate.mjs'),
      '--engine', 'mock', '--mock-mode', 'echo',
      '--locales', 'ko-KR', '--limit', '4',
      '--cache-dir', sandbox, '--out', outFile,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.ok(/retranslation still the source text/.test(out), 'it must report "retranslation still the source text": ' + out.slice(-300));
  const machine = JSON.parse(fs.readFileSync(outFile, 'utf8'))['ko-KR'] ?? {};
  const han = Object.values(machine).filter((v) => /[\u4e00-\u9fff]/.test(String(v)));
  assert.equal(han.length, 0, 'invalid entries must not reach the machine layer, got ' + JSON.stringify(han.slice(0, 3)));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

t('model invents a sentinel (the source has no placeholder at all) -> likewise not written', () => {
  // Real incident: a zh entry with no placeholder came back with a ⟦0⟧ the model made up, and
  // restore() only checked "did an emitted sentinel go missing", never "did extra sentinels
  // appear in the translation" - so "daqui a ⟦0⟧ dias" landed in the Portuguese UI.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-i18n-sent-'));
  const outFile = path.join(sandbox, 'machine.json');
  const out = execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'tools/i18n-translate.mjs'),
      '--engine', 'mock', '--mock-mode', 'sentinel',
      '--locales', 'pt-PT', '--limit', '3',
      '--cache-dir', sandbox, '--out', outFile,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.ok(/stray sentinel/.test(out), 'it must report "stray sentinel": ' + out.slice(-300));
  const machine = JSON.parse(fs.readFileSync(outFile, 'utf8'))['pt-PT'] ?? {};
  const stray = Object.entries(machine).filter(([, v]) => /⟦\d+⟧/.test(String(v)));
  assert.equal(stray.length, 0, 'entries with stray sentinels must not reach the machine layer, got ' + JSON.stringify(stray.slice(0, 2)));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

t('--bust terms: the predicate re-translates only entries holding proper nouns (pure logic, unit-tested rather than run as a CLI)', () => {  const glossary = { Telegram: { default: 'Telegram' } };
  // none: always use the cache
  assert.equal(needsRetranslate('Telegram 推送失败', 'none', glossary), false);
  // all: re-translate everything
  assert.equal(needsRetranslate('保存', 'all', glossary), true);
  // terms: re-translate only on a glossary hit or a capitalised Latin fragment that looks like a brand name
  assert.equal(needsRetranslate('Telegram 推送失败', 'terms', glossary), true);
  assert.equal(needsRetranslate('Bark 的 key', 'terms', glossary), true);
  assert.equal(needsRetranslate('SQLite 归档', 'terms', glossary), true);
  assert.equal(needsRetranslate('保存', 'terms', glossary), false, 'a purely Chinese label must not be re-translated');
  assert.equal(needsRetranslate('今天', 'terms', glossary), false);
  assert.equal(needsRetranslate('把情报打成一个单文件发给朋友', 'terms', glossary), false);
});

t('the cache file carries no secrets (only source-string hashes -> translations)', () => {
  const cachePath = path.join(ROOT, 'web/src/locales/.cache/ja-JP.json');
  if (!fs.existsSync(cachePath)) return;
  const raw = fs.readFileSync(cachePath, 'utf8');
  assert.ok(!/sk-|apiKey|Bearer/i.test(raw), 'the cache must not contain any credentials');
  const obj = JSON.parse(raw);
  for (const k of Object.keys(obj)) assert.match(k, /^[0-9a-f]{20}$/);
});

t('without --locales it prints usage and exits 2 (no accidental run)', () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), '--engine', 'mock'], { cwd: ROOT, encoding: 'utf8' });
    assert.fail('it must exit with a non-zero code');
  } catch (e) {
    assert.equal(e.status, 2, 'the exit code must be 2');
  }
});

t('the openai engine refuses to run without url/key (never calls out with an empty key)', () => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-translate.mjs'), '--engine', 'openai', '--locales', 'ja-JP'], { cwd: ROOT, encoding: 'utf8' });
    assert.fail('it must exit with a non-zero code');
  } catch (e) {
    assert.equal(e.status, 2);
  }
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

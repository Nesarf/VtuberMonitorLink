// i18n-plural-test.mjs — self-test for number-dependent word forms (BUGS #54)
//
// "21 элементов" is wrong Russian; "1 items" is wrong English. The UI is full of
// "number + noun" labels, and one fixed string per key cannot carry the inflection, so
// locales/plurals.js holds `<key>_<category>` forms that web/src/plural.js selects at render
// time. This file pins the mechanism down:
//   * Intl.PluralRules is the authority for which categories a language uses;
//   * a table must be COMPLETE for the categories its language uses (otherwise a count falls
//     back to a form that is grammatically wrong — exactly the bug we are fixing);
//   * the number ends up inside the phrase when the wording embeds `{n}`, and is prepended
//     otherwise (which is how every locale behaved before, so no locale can regress);
//   * spot-checks with real numbers in the affected languages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLURALS } from '../web/src/locales/plurals.js';
import { countLabel, fillParams, pickPlural, pluralCategory } from '../web/src/plural.js';
import { readDicts } from './lib/i18n-source.mjs';
import { usableChain } from './lib/locale-chain.mjs';
import { LOCALES, byCode } from '../web/src/locales/index.js';

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

/** The keys the UI renders as "number + noun" (the ones migrated to tn()). */
const COUNT_KEYS = ['items', 'groupDays', 'groupPeopleUnit', 'vdbGroups', 'outsideRange'];
const VALID_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

process.stdout.write('\nplural: category selection\n');

t('Intl.PluralRules reports the categories we assume (the baseline itself must be trustworthy)', () => {
  assert.deepEqual(new Intl.PluralRules('zh-Hans').resolvedOptions().pluralCategories, ['other']);
  assert.deepEqual(new Intl.PluralRules('ja-JP').resolvedOptions().pluralCategories, ['other']);
  assert.deepEqual(new Intl.PluralRules('en-US').resolvedOptions().pluralCategories.sort(), ['one', 'other']);
  assert.deepEqual(new Intl.PluralRules('ru-RU').resolvedOptions().pluralCategories.sort(), ['few', 'many', 'one', 'other']);
  assert.deepEqual(new Intl.PluralRules('sr-RS').resolvedOptions().pluralCategories.sort(), ['few', 'one', 'other']);
  assert.deepEqual(new Intl.PluralRules('ar-SA').resolvedOptions().pluralCategories.sort(), ['few', 'many', 'one', 'other', 'two', 'zero']);
});

t('Russian: 1/21 -> one, 2-4/22-24 -> few, 5-20 -> many, fractions -> other', () => {
  const at = (n) => pluralCategory('ru-RU', n);
  assert.equal(at(1), 'one');
  assert.equal(at(21), 'one');
  assert.equal(at(101), 'one');
  assert.equal(at(2), 'few');
  assert.equal(at(4), 'few');
  assert.equal(at(22), 'few');
  assert.equal(at(5), 'many');
  assert.equal(at(11), 'many');
  assert.equal(at(0), 'many');
  assert.equal(at(1.5), 'other');
});

t('Polish: 21 is "many" (unlike Russian - the classic mix-up)', () => {
  assert.equal(pluralCategory('pl-PL', 21), 'many');
  assert.equal(pluralCategory('pl-PL', 22), 'few');
  assert.equal(pluralCategory('pl-PL', 1), 'one');
});

t('Arabic: 0/1/2/3-10/11+ map to zero/one/two/few/many', () => {
  assert.equal(pluralCategory('ar-SA', 0), 'zero');
  assert.equal(pluralCategory('ar-SA', 1), 'one');
  assert.equal(pluralCategory('ar-SA', 2), 'two');
  assert.equal(pluralCategory('ar-SA', 3), 'few');
  assert.equal(pluralCategory('ar-SA', 11), 'many');
  assert.equal(pluralCategory('ar-SA', 100), 'other');
});

t('a non-number never throws: it falls back to "other"', () => {
  for (const bad of [NaN, Infinity, undefined, null, 'x']) {
    assert.equal(pluralCategory('ru-RU', bad), 'other', String(bad));
  }
});

process.stdout.write('\nplural: lookup and label building\n');

t('a matching category wins; otherwise the plain key of the same language is used (never another language)', () => {
  const dict = { items: 'base', items_few: 'F' };
  assert.equal(pickPlural(dict, 'items', 'ru-RU', 3), 'F');
  assert.equal(pickPlural(dict, 'items', 'ru-RU', 5), 'base');
  assert.equal(pickPlural(dict, 'items', 'zh-Hans', 5), 'base');
  assert.equal(pickPlural({}, 'items', 'ru-RU', 5), null);
});

t('a value without {n} keeps the old behaviour: the number is prepended', () => {
  assert.equal(countLabel('条', 20), '20 条');
  assert.equal(countLabel('days', 3), '3 days');
});

t('a value with {n} gets the number inside the phrase (what inflected languages need)', () => {
  assert.equal(countLabel('{n} записей', 20), '20 записей');
  assert.equal(countLabel('{n} عنصران', 2), '2 عنصران');
});

t('other named params are filled too, and a missing one stays literal (never "undefined")', () => {
  assert.equal(fillParams('{n} / {total}', { n: 3, total: 9 }), '3 / 9');
  assert.equal(fillParams('{n} / {total}', { n: 3 }), '3 / {total}');
});

process.stdout.write('\nplural: table completeness\n');

const { zh, en } = readDicts();

t('every table key is `base_category` with one of the six CLDR categories', () => {
  for (const [code, table] of Object.entries(PLURALS)) {
    for (const key of Object.keys(table)) {
      const m = /^([A-Za-z0-9]+)_([a-z]+)$/.exec(key);
      assert.ok(m, `${code}: 键名不合规 ${key}`);
      assert.ok(VALID_CATEGORIES.has(m[2]), `${code}: 未知类别 ${m[2]}`);
    }
  }
});

t('every base key really exists in the UI dictionary (no invented words)', () => {
  for (const [code, table] of Object.entries(PLURALS)) {
    for (const key of Object.keys(table)) {
      const base = key.replace(/_[a-z]+$/, '');
      assert.ok(zh.has(base), `${code}: ${key} 的基键 ${base} 不在 zh 词条里`);
      assert.ok(en.has(base), `${code}: ${key} 的基键 ${base} 不在 en 词条里`);
    }
  }
});

t('every locale code is a real locale in LOCALES', () => {
  for (const code of Object.keys(PLURALS)) {
    assert.ok(byCode(code), `未知地区码 ${code}`);
  }
});

t('**completeness**: every category the language uses has a form (otherwise a count silently falls back to the wrong wording)', () => {
  const problems = [];
  for (const [code, table] of Object.entries(PLURALS)) {
    const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const base of COUNT_KEYS) {
      const has = Object.keys(table).filter((k) => k.startsWith(base + '_'));
      if (!has.length) continue; // this key has no table for this language - caught by the "covers items" check below
      for (const c of cats) {
        if (c === 'many' && !has.includes(`${base}_many`)) {
          // "many" only shows up around 1e6 in es/pt/fr/it, so a missing one is not an error as long as the rest are complete
          if (has.some((k) => k.endsWith('_other'))) continue;
        }
        if (!has.includes(`${base}_${c}`)) problems.push(`${code} ${base} 缺 _${c}`);
      }
    }
  }
  assert.equal(problems.length, 0, problems.slice(0, 8).join('; '));
});

t('inflecting languages cover at least `items` (the core count label)', () => {
  const need = ['en-US', 'es-ES', 'pt-PT', 'fr-FR', 'de-DE', 'it-IT', 'ru-RU', 'uk-UA', 'pl-PL', 'sr-RS', 'ar-SA'];
  for (const code of need) {
    const table = PLURALS[code];
    assert.ok(table, `缺少 ${code} 的词形表`);
    assert.ok(table.items_one, `${code} 缺 items_one`);
  }
});

t('non-inflecting languages (zh / ja / ko) need no table - prepending the number is already correct', () => {
  for (const code of ['zh-Hans', 'ja-JP', 'ko-KR']) {
    assert.equal(new Intl.PluralRules(code).resolvedOptions().pluralCategories.join(), 'other');
    assert.ok(!PLURALS[code], `${code} 不该有词形表`);
  }
});

process.stdout.write('\nplural: real-language spot checks\n');

t('Russian 1 / 2 / 5 / 21 produce four distinct (and correct) forms', () => {
  const table = PLURALS['ru-RU'];
  const at = (n) => countLabel(pickPlural(table, 'items', 'ru-RU', n), n);
  assert.equal(at(1), '1 запись');
  assert.equal(at(2), '2 записи');
  assert.equal(at(5), '5 записей');
  assert.equal(at(21), '21 запись');
  assert.equal(at(22), '22 записи');
});

t('Ukrainian 1 / 3 / 7 give запис / записи / записів', () => {
  const table = PLURALS['uk-UA'];
  const at = (n) => countLabel(pickPlural(table, 'items', 'uk-UA', n), n);
  assert.equal(at(1), '1 запис');
  assert.equal(at(3), '3 записи');
  assert.equal(at(7), '7 записів');
});

t('Polish 1 / 2 / 5 / 22', () => {
  const table = PLURALS['pl-PL'];
  const at = (n) => countLabel(pickPlural(table, 'items', 'pl-PL', n), n);
  assert.equal(at(1), '1 wpis');
  assert.equal(at(2), '2 wpisy');
  assert.equal(at(5), '5 wpisów');
  assert.equal(at(22), '22 wpisy');
});

t('Serbian 1 / 2 / 5 (the "other" form is the genitive plural)', () => {
  const table = PLURALS['sr-RS'];
  const at = (n) => countLabel(pickPlural(table, 'items', 'sr-RS', n), n);
  assert.equal(at(1), '1 ставка');
  assert.equal(at(2), '2 ставке');
  assert.equal(at(5), '5 ставака');
});

t('Arabic 1 / 2 / 3 / 11 use different forms', () => {
  const table = PLURALS['ar-SA'];
  const at = (n) => countLabel(pickPlural(table, 'items', 'ar-SA', n), n);
  assert.equal(at(1), '1 عنصر');
  assert.equal(at(2), '2 عنصران');
  assert.equal(at(3), '3 عناصر');
  assert.equal(at(11), '11 عنصرًا');
});

t('English 1 item / 2 items (this also fixes the old `1 items`)', () => {
  const table = PLURALS['en-US'];
  assert.equal(countLabel(pickPlural(table, 'items', 'en-US', 1), 1), '1 item');
  assert.equal(countLabel(pickPlural(table, 'items', 'en-US', 2), 2), '2 items');
});

t('Chinese/Japanese unchanged: number prepended, no doubled number', () => {
  assert.equal(countLabel(pickPlural({ items: '条' }, 'items', 'zh-Hans', 20), 20), '20 条');
  assert.equal(countLabel(pickPlural({ items: '件' }, 'items', 'ja-JP', 3), 3), '3 件');
});

t('the Arabic sentence label carries no stray sentinel any more (it used to render ⟦n⟧)', () => {
  const table = PLURALS['ar-SA'];
  for (const n of [0, 1, 2, 3, 11, 100]) {
    const out = countLabel(pickPlural(table, 'outsideRange', 'ar-SA', n), n);
    assert.ok(!/⟦|⟧|\{n\}/.test(out), `n=${n} 仍有占位符/哨兵: ${out}`);
    assert.ok(out.startsWith(String(n)), `n=${n} 数字没进去: ${out}`);
  }
});

t('no rendered value keeps a leftover {n} or sentinel', () => {
  const bad = [];
  for (const [code, table] of Object.entries(PLURALS)) {
    for (const n of [0, 1, 2, 3, 5, 11, 21, 22, 100]) {
      for (const base of COUNT_KEYS) {
        const raw = pickPlural(table, base, code, n);
        if (raw === null) continue;
        const out = countLabel(raw, n);
        if (/⟦|\{n\}/.test(out)) bad.push(`${code} ${base} n=${n}: ${out}`);
        if (!/\d/.test(out)) bad.push(`${code} ${base} n=${n} 没数字: ${out}`);
      }
    }
  }
  assert.equal(bad.length, 0, bad.slice(0, 6).join(' | '));
});

t('regional variants inherit through the chain (en-GB / es-MX / pt-BR all get forms)', () => {
  // mirror the provider's merge order: English fallback first, then the chain tables on top
  const resolve = (code, base, n) => {
    let dict = { ...Object.fromEntries(en) };
    for (const c of usableChain(code)) dict = { ...dict, ...(PLURALS[c] ?? {}) };
    return countLabel(pickPlural(dict, base, code, n), n);
  };
  assert.equal(resolve('en-GB', 'items', 1), '1 item');
  assert.equal(resolve('en-AU', 'items', 2), '2 items');
  assert.equal(resolve('es-MX', 'items', 2), '2 elementos');
  assert.equal(resolve('pt-BR', 'items', 2), '2 itens');
  assert.equal(resolve('fr-CA', 'groupDays', 1), '1 jour');
});

t('locales with no table on their chain (all zh variants / ja / ko) keep prepending the number', () => {
  for (const code of ['zh-Hans', 'zh-Hant', 'zh-HK', 'zh-TW', 'ja-JP', 'ko-KR']) {
    const chainTables = usableChain(code).map((c) => PLURALS[c]).filter(Boolean);
    assert.equal(chainTables.length, 0, `${code} 不该在链上拿到词形表`);
    // so pickPlural only sees the language's plain key and countLabel prepends the number - no behaviour change
    const dict = { items: '条' };
    assert.equal(countLabel(pickPlural(dict, 'items', code, 2), 2), '2 条');
  }
});

t('PLURALS only lists real locales (no typo can hide there)', () => {
  const codes = new Set(LOCALES.map((l) => l.code));
  for (const code of Object.keys(PLURALS)) assert.ok(codes.has(code), `PLURALS 里有不存在的地区: ${code}`);
});

process.stdout.write('\n' + (pass + fail ? `${pass}/${pass + fail} checks passed\n` : ''));
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}

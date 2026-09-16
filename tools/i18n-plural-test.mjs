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
import { HAND_COMMON } from '../web/src/locales/overlays.js';
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
const COUNT_KEYS = [
  'items', 'groupDays', 'groupPeopleUnit', 'vdbGroups', 'outsideRange',
  // plain "count + noun" labels: agency members, followed people, LLM calls, search hits,
  // run alerts, cookie counts (with and without a session) and follower counts
  'groupMembers', 'groupPeopleCount', 'costCalls', 'matches', 'alerts',
  'cookieCount', 'cookieCountWithSession', 'followersCount',
];
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

t('non-inflecting languages (zh / ja / ko / id) need no table - prepending the number is already correct', () => {
  // id-ID joined this list when the locale was added: Intl.PluralRules('id') resolves to a single
  // category (`other`), so an Indonesian table could only ever hold one form, and the default
  // "number in front" of countLabel() is already correct Indonesian word order.
  for (const code of ['zh-Hans', 'ja-JP', 'ko-KR', 'id-ID']) {
    assert.equal(new Intl.PluralRules(code).resolvedOptions().pluralCategories.join(), 'other');
    assert.ok(!PLURALS[code], `${code} 不该有词形表`);
  }
});

t('fil-PH is NOT in that list, and the measured rule is by last digit rather than "all integers"', () => {
  // Added with the Filipino locale. Filipino resolves to two categories, so it cannot join the
  // non-inflecting group above -- and the split is real, not decorative: measured over 0..2000,
  // `other` is selected exactly when `n % 10` is 4, 6 or 9 (600 of 2001, 30%), and `one` for every
  // other integer including 0 and 1.
  //
  // The first version of this test asserted "every integer is `one`" because the probe that produced
  // the numbers spot-checked 0/1/2/3/5/10/11/21/100 -- all of them `one` -- and its 0..2000 result was
  // printed as a Set that nobody read. That is exactly the class of mistake a pinned measurement is
  // supposed to prevent, so the assertion below spells the rule out instead of sampling it.
  //
  // The table Filipino needs is not about inflection: Tagalog puts the linker `na` between a numeral
  // and the noun it counts (`5 na item`, `2 na araw`), which prepending a number to a bare noun cannot
  // express. Both categories therefore carry the same wording -- the linker does not change with the
  // number -- and this test pins that too, so nobody "optimises" one of them away.
  const fil = new Intl.PluralRules('fil-PH');
  assert.equal(fil.resolvedOptions().pluralCategories.sort().join(), 'one,other');
  const wrong = [];
  for (let n = 0; n <= 2000; n++) {
    const wantOther = [4, 6, 9].includes(n % 10);
    if (wantOther !== (fil.select(n) === 'other')) wrong.push(`${n}->${fil.select(n)}`);
  }
  assert.equal(wrong.length, 0, 'fil 的类别划分变了（应为末位 4/6/9 归 other）: ' + wrong.slice(0, 6).join(', '));
  assert.equal(fil.select(1), 'one');
  assert.equal(fil.select(21), 'one');
  assert.equal(fil.select(4), 'other');
  assert.equal(pluralCategory('fil-PH', Number.NaN), 'other', 'other 也是非数字回退');
  // Both categories must exist (the completeness check above requires it) and must agree: there is
  // nothing for the number to inflect here.
  const table = PLURALS['fil-PH'];
  assert.ok(table, 'fil-PH 缺少词形表');
  for (const base of ['items', 'groupDays', 'groupMembers', 'alerts']) {
    assert.equal(table[`${base}_one`], table[`${base}_other`], `${base}: fil 的两个类别本来就该一样`);
    assert.ok(table[`${base}_one`].includes('{n}'), `${base}: 数词要留在短语里，才能带上 na 连接词`);
  }
  // The linker is the whole point of the table: without it the label is a fragment. Both a `one` and
  // an `other` number have to come out right, since only 30% of counts are `one`.
  assert.equal(countLabel(pickPlural(table, 'items', 'fil-PH', 5), 5), '5 na item');
  assert.equal(countLabel(pickPlural(table, 'items', 'fil-PH', 4), 4), '4 na item');
  assert.equal(countLabel(pickPlural(table, 'groupDays', 'fil-PH', 1), 1), '1 na araw');
  assert.equal(countLabel(pickPlural(table, 'alerts', 'fil-PH', 6), 6), '6 na babala');
  // `outsideRange` is the exception: its wording is a sentence, and the linker needs a noun after it.
  assert.equal(countLabel(pickPlural(table, 'outsideRange', 'fil-PH', 3), 3), '3 hindi kasama ng filter ng oras');
  assert.equal(countLabel(pickPlural(table, 'outsideRange', 'fil-PH', 9), 9), '9 hindi kasama ng filter ng oras');
});

process.stdout.write('\nplural: real-language spot checks\n');

t('th-TH is NOT in the non-inflecting list either: the rule is "numeral + classifier", and the measurement cannot see it', () => {
  // Added with the Thai locale, which lands in the same third tier as Filipino for a different
  // reason. The measurement first, because the measurement is what makes the naive reading wrong:
  //
  //   `Intl.PluralRules('th').resolvedOptions().pluralCategories` is `["other"]` -- one category.
  //   Measured over 0..2000, `select(n)` is `other` for all 2001 integers, with no residue class and
  //   no threshold anywhere, and decimals (1.5 / 2.5 / 100.5) select `other` too. So the category
  //   count says "this locale is like zh / ja / ko / id" and the two-tier reading of DESIGN.md
  //   section 11 would put Thai in the "prepend the number to a bare noun" tier and close the case.
  //
  //   What that reading cannot see is that the bare noun is not a Thai count label. Thai counts with
  //   a numeral plus a **classifier** (`3 รายการ`, `2 วัน`, `5 ครั้ง`, `10 คน`, `4 กลุ่ม`), and the
  //   classifier is a word that belongs *inside* the phrase -- a value with no `{n}` is prepended to
  //   by countLabel() and cannot carry one. That is a need no plural-form *count* can express, in
  //   either direction, exactly as the Filipino linker was.
  //
  //   The first probe of this locale printed the same two-category-style summary ("single category,
  //   all integers `other`") and it would have been easy to stop there; the numbers are written out
  //   below so the next reader does not have to re-derive them, and the classifier wording is pinned
  //   so nobody can "simplify" the table into the bare-numeral tier without deleting a form.
  const th = new Intl.PluralRules('th');
  assert.equal(th.resolvedOptions().pluralCategories.join(), 'other', 'th reports more than one category now');
  const nonOther = [];
  for (let n = 0; n <= 2000; n++) if (th.select(n) !== 'other') nonOther.push(`${n}->${th.select(n)}`);
  assert.equal(nonOther.length, 0, 'th no longer selects `other` for every integer: ' + nonOther.slice(0, 6).join(', '));
  for (const n of [1.5, 2.5, 0.5, 100.5]) assert.equal(th.select(n), 'other', `th decimal ${n}`);
  assert.equal(pluralCategory('th-TH', Number.NaN), 'other', 'other is still the non-number fallback');
  // A single category means exactly one form per key: a `_one` companion could never be selected, and
  // the completeness check above requires precisely the categories the language uses.
  const table = PLURALS['th-TH'];
  assert.ok(table, 'th-TH has no form table');
  for (const key of Object.keys(table)) {
    assert.ok(key.endsWith('_other'), `${key}: th has one category, so no other suffix belongs here`);
  }
  // Every count key is covered, and every form puts the numeral inside the phrase - that is the whole
  // point of the table, so a base value alone must NOT be what a count label renders.
  const COUNT_KEYS_LOCAL = [
    'items', 'groupDays', 'groupPeopleUnit', 'vdbGroups', 'outsideRange', 'groupMembers',
    'groupPeopleCount', 'costCalls', 'matches', 'alerts', 'cookieCount', 'cookieCountWithSession',
    'followersCount',
  ];
  for (const base of COUNT_KEYS_LOCAL) {
    const form = table[`${base}_other`];
    assert.ok(typeof form === 'string' && form.includes('{n}'), `${base}: the numeral belongs inside the phrase`);
    assert.equal(countLabel(pickPlural(table, base, 'th-TH', 3), 3).startsWith('3 '), true, base);
  }
  // The classifier is the reason the table exists, so the classifier words are pinned by name.
  assert.equal(countLabel(pickPlural(table, 'items', 'th-TH', 12), 12), '12 รายการ');
  assert.equal(countLabel(pickPlural(table, 'groupDays', 'th-TH', 2), 2), '2 วัน');
  assert.equal(countLabel(pickPlural(table, 'groupPeopleUnit', 'th-TH', 4), 4), '4 คน');
  assert.equal(countLabel(pickPlural(table, 'costCalls', 'th-TH', 5), 5), '5 ครั้ง');
  assert.equal(countLabel(pickPlural(table, 'alerts', 'th-TH', 1), 1), '1 การแจ้งเตือน');
  assert.equal(countLabel(pickPlural(table, 'groupMembers', 'th-TH', 21), 21), '21 สมาชิก');
  assert.equal(countLabel(pickPlural(table, 'followersCount', 'th-TH', 1), 1), '1 ผู้ติดตาม');
  // The same number has to be right for a `one`-ish and an `other`-ish count alike (there is only one
  // category here, but a count label is read at 1 and at 21 both).
  assert.equal(countLabel(pickPlural(table, 'items', 'th-TH', 1), 1), '1 รายการ');
  // Every form is Thai script, and none of them is a bare numeral left behind.
  for (const [key, form] of Object.entries(table)) {
    assert.ok(/[\u0e00-\u0e7f]/.test(form), `${key}: the value must contain Thai characters: ${form}`);
    assert.ok(form.replace('{n}', '').trim().length > 0, `${key}: a number with no noun`);
  }
});

t('Thai count labels carry their classifier - the failure mode that must be visible to this test', () => {
  // A negative control, so this file cannot pass on a broken table the way the class of bug it exists
  // for would: `12 รายการ` and `12รายการ` differ by one space, and the classifier is what makes the
  // label a phrase. The predicate below is what tools/traverse-ui.cjs asserts against the rendered
  // page (see its Thai block); it is repeated here over table values so an offline run catches a
  // regression before a browser has to.
  //
  // Combining marks are stripped before the test: a tone mark sits between a digit and the classifier
  // in a glued string, and without this the negative control would pass for the wrong reason.
  const marks = /[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/g;
  const classifierRe = /^\d+ [\u0e00-\u0e7f]/;
  const good = '12 รายการ';
  const glued = '12\u0e48รายการ'; // the same label with the space removed (and a tone mark)
  assert.ok(classifierRe.test(good), `the classifier predicate rejects the correct wording: ${good}`);
  assert.equal(classifierRe.test(glued.replace(marks, '')), false, `the classifier predicate accepts a glued label: ${glued}`);
  // And the real table values satisfy it.
  for (const [key, form] of Object.entries(PLURALS['th-TH'])) {
    const rendered = countLabel(form, 12);
    assert.ok(classifierRe.test(rendered), `${key}: the rendered label is not "number space Thai": ${rendered}`);
  }
});

t('vi-VN needs no table either - and the tier it lands in is a measurement, not an inference from the count', () => {
  // Added with the Vietnamese locale (the 29th), which is the first locale to reach the bare-numeral
  // tier *after* Filipino and Thai showed that the tier has to be earned rather than read off the
  // category count. Both halves are therefore pinned here: the measurement, and the wording the
  // measurement is only half the evidence for.
  //
  // The measurement, spelled out rather than sampled (the Filipino mistake was reading a spot check as
  // the rule, and the Thai mistake would have been stopping at the first plausible answer):
  //
  //   `Intl.PluralRules('vi').resolvedOptions().pluralCategories` is `["other"]` -- one category.
  //   Measured over 0..2000, `select(n)` is `other` for all 2001 integers: no residue class, no
  //   last-digit rule, no threshold. Decimals select `other` as well (0.5 / 1.5 / 2.5 / 100.5 /
  //   1000.25), and `other` is also the non-number fallback in web/src/plural.js. So a `vi-VN` table
  //   could hold exactly one form per key, and that form could only repeat the base value in
  //   overlays.js -- a table that cannot change any label.
  //
  //   What the count cannot see is word order, and that is where Vietnamese differs from Thai and
  //   Filipino instead of resembling them: Thai needs the classifier as a separate obligatory word
  //   (`3 รายการ`), Tagalog needs the linker `na` (`5 na item`) -- both are words that are not the
  //   noun, which is why a bare noun after a numeral is a fragment there. Vietnamese puts the numeral
  //   directly in front of the unit word, and for every count key in this project that unit word IS
  //   the head noun (`12 mục`, `2 ngày`, `4 người`, `4 nhóm`, `5 thành viên`, `5 lượt gọi`,
  //   `3 kết quả khớp`, `6 cảnh báo`, `36 cookie`, `128 người theo dõi`). Where Vietnamese does need a
  //   classifier (`3 con mèo`, `2 quyển sách`) it belongs to individual-object nouns, a class none of
  //   these keys counts -- so the wording, not a table, is what keeps these labels idiomatic, and the
  //   exact rendered labels are pinned below.
  //
  //   This is also why vi-VN is *not* simply appended to the zh/ja/ko/id list above: that list asserts
  //   "one category, so nothing to say"; here there is something to say (the unit word), and it is
  //   asserted. A future reader who wants to add a table has to delete a pinned label to do it, and a
  //   reader who wants to drop the unit words out of the base values fails the same assertion.
  const vi = new Intl.PluralRules('vi-VN');
  assert.equal(vi.resolvedOptions().pluralCategories.join(), 'other', 'vi reports more than one category now');
  const nonOther = [];
  for (let n = 0; n <= 2000; n++) if (vi.select(n) !== 'other') nonOther.push(`${n}->${vi.select(n)}`);
  assert.equal(nonOther.length, 0, 'vi no longer selects `other` for every integer: ' + nonOther.slice(0, 6).join(', '));
  for (const n of [0.5, 1.5, 2.5, 100.5, 1000.25]) assert.equal(vi.select(n), 'other', `vi decimal ${n}`);
  assert.equal(pluralCategory('vi-VN', Number.NaN), 'other', 'other is still the non-number fallback');
  assert.ok(!PLURALS['vi-VN'], 'vi-VN has a form table now: with a single category it can only repeat the base value, so the reason for it has to be written down in locales/plurals.js first');
  // The wording: the base values of the hand layer, rendered through the real lookup path. `dict` is
  // the hand layer alone, because with no table on the chain that is exactly what pickPlural() sees.
  const bases = HAND_COMMON['vi-VN'];
  assert.ok(bases, 'vi-VN has no hand layer, so it has no count wording');
  const expected = {
    items: [12, '12 mục'],
    groupDays: [2, '2 ngày'],
    groupPeopleUnit: [4, '4 người'],
    vdbGroups: [4, '4 nhóm'],
    outsideRange: [12, '12 mục bị loại bởi bộ lọc thời gian'],
    groupMembers: [21, '21 thành viên'],
    groupPeopleCount: [3, '3 người được theo dõi'],
    costCalls: [5, '5 lượt gọi'],
    matches: [3, '3 kết quả khớp'],
    alerts: [6, '6 cảnh báo'],
    cookieCount: [36, '36 cookie'],
    cookieCountWithSession: [36, '36 cookie (gồm SESSDATA)'],
    followersCount: [128, '128 người theo dõi'],
  };
  for (const [key, [n, label]] of Object.entries(expected)) {
    assert.equal(countLabel(pickPlural({ ...bases }, key, 'vi-VN', n), n), label, `${key}: the rendered count label moved`);
  }
  // One is not a special case in Vietnamese, and neither is a signed follower delta: the delta is passed
  // through as a string ("+12") by whoever renders it. No page passes `followersCount` any more -- the
  // render sites went with the platform that produced the reading -- but the form is pinned here because
  // the key is still in the dictionary, and a wording that broke would break quietly (see the `follower`
  // comment in server/src/server.js).
  assert.equal(countLabel(pickPlural({ ...bases }, 'items', 'vi-VN', 1), 1), '1 mục');
  assert.equal(countLabel(pickPlural({ ...bases }, 'followersCount', 'vi-VN', '+12'), '+12'), '+12 người theo dõi');
  // Every pinned label is a number, a space and a Vietnamese unit word -- a base value reduced to a
  // bare numeral, or left as the English noun, fails right here. `cookie` is deliberately NOT in the
  // English-noun pattern: it is a loanword and it *is* the Vietnamese wording (the same call Thai's
  // `คุกกี้` and Filipino's `cookie` record), so `36 cookie` is a correct label and flagging it would
  // make this check lie. The two cookie labels are pinned by name in the map above instead.
  for (const [key, [n]] of Object.entries(expected)) {
    const rendered = countLabel(pickPlural({ ...bases }, key, 'vi-VN', n), n);
    const bare = rendered.replace(/^[+-]?\d+\s*/, '');
    assert.ok(bare.length > 0, `${key}: a number with no noun: ${rendered}`);
    assert.ok(!/^(items?|days?|members?|matches|calls|alerts|followers?|groups?|people)\b/i.test(bare), `${key}: the English noun is still there: ${rendered}`);
  }
});

t('the Vietnamese count-label predicate can fail (negative control), and it is the one the traversal uses', () => {
  // A negative control, so the traversal assertion (see the vi-VN block in tools/traverse-ui.cjs)
  // cannot be an assertion that only ever prints [ok]. Vietnamese has no linker and no classifier to
  // look for in these labels -- the shape to assert is "number, space, one of the pinned Vietnamese
  // unit words", which is a predicate that says nothing about the language's grammar and everything
  // about which wording this locale actually renders.
  const count = /\d+ (?:mục|ngày|người|nhóm|thành viên|lượt gọi|kết quả khớp|cảnh báo|cookie)\b/;
  const glued = /\d+(?:mục|ngày|người|nhóm|thành viên|lượt gọi|kết quả khớp|cảnh báo|cookie)\b/;
  // No `cookies?` here either: `36 cookie` is the wording this locale intends (see the comment in the
  // test above), so an English-fallback pattern that includes it would turn a correct label into a
  // failure in the traversal, where the same pattern is reused.
  const english = /\b\d+\s+(?:items?|days?|members?|matches|calls|alerts|followers?|groups?|people)\b/;
  assert.ok(count.test('12 mục') && count.test('2 ngày'), 'the predicate rejects a correct Vietnamese count label');
  assert.equal(count.test('12mục'), false, 'the predicate accepts a glued label');
  assert.equal(count.test('12 items'), false, 'the predicate accepts the English fallback');
  assert.ok(glued.test('12mục'), 'the glued-label control cannot fire');
  assert.ok(english.test('12 items'), 'the English-fallback control cannot fire');
  // And the real hand-layer wording satisfies it (the same values this test pins by name above).
  for (const key of ['items', 'groupDays', 'groupPeopleUnit', 'vdbGroups', 'outsideRange', 'groupMembers', 'groupPeopleCount', 'costCalls', 'matches', 'alerts', 'cookieCount', 'cookieCountWithSession', 'followersCount']) {
    const rendered = countLabel(HAND_COMMON['vi-VN'][key], 12);
    assert.ok(count.test(rendered), `${key}: the rendered label does not read as "number space unit word": ${rendered}`);
    assert.equal(english.test(rendered), false, `${key}: the rendered label contains an English count noun: ${rendered}`);
  }
});

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

t('Russian count labels take the right case: 1 участник / 2 участника / 5 участников', () => {
  const table = PLURALS['ru-RU'];
  const at = (key, n) => countLabel(pickPlural(table, key, 'ru-RU', n), n);
  assert.equal(at('groupMembers', 1), '1 участник');
  assert.equal(at('groupMembers', 2), '2 участника');
  assert.equal(at('groupMembers', 5), '5 участников');
  assert.equal(at('groupMembers', 21), '21 участник');
  assert.equal(at('groupMembers', 22), '22 участника');
  assert.equal(at('costCalls', 1), '1 вызов');
  assert.equal(at('costCalls', 3), '3 вызова');
  assert.equal(at('costCalls', 5), '5 вызовов');
  assert.equal(at('matches', 1), '1 совпадение');
  assert.equal(at('matches', 2), '2 совпадения');
  assert.equal(at('matches', 5), '5 совпадений');
  assert.equal(at('followersCount', 1), '1 фанат');
  assert.equal(at('followersCount', 5), '5 фанатов');
});

t('Arabic uses the dual for 2 and the accusative singular from 11 up', () => {
  const table = PLURALS['ar-SA'];
  const at = (key, n) => countLabel(pickPlural(table, key, 'ar-SA', n), n);
  assert.equal(at('groupMembers', 1), '1 عضو');
  assert.equal(at('groupMembers', 2), '2 عضوان');
  assert.equal(at('groupMembers', 3), '3 أعضاء');
  assert.equal(at('groupMembers', 11), '11 عضوًا');
  assert.equal(at('groupMembers', 100), '100 عضو');
  assert.equal(at('followersCount', 2), '2 متابعان');
  assert.equal(at('followersCount', 3), '3 متابعين');
  assert.equal(at('followersCount', 11), '11 متابعًا');
  assert.equal(at('cookieCountWithSession', 2), '2 عنصران (بما في ذلك SESSDATA)');
});

t('Polish masculine-personal members take the genitive plural after 2-4; Serbian followers inflect', () => {
  const pl = PLURALS['pl-PL'];
  const atPl = (key, n) => countLabel(pickPlural(pl, key, 'pl-PL', n), n);
  assert.equal(atPl('groupMembers', 1), '1 członek');
  assert.equal(atPl('groupMembers', 2), '2 członków');
  assert.equal(atPl('groupMembers', 5), '5 członków');
  assert.equal(atPl('groupMembers', 21), '21 członków');
  assert.equal(atPl('costCalls', 2), '2 wywołania');
  assert.equal(atPl('costCalls', 5), '5 wywołań');
  assert.equal(atPl('alerts', 3), '3 alerty');
  const sr = PLURALS['sr-RS'];
  const atSr = (key, n) => countLabel(pickPlural(sr, key, 'sr-RS', n), n);
  assert.equal(atSr('followersCount', 1), '1 пратилац');
  assert.equal(atSr('followersCount', 2), '2 пратиоца');
  assert.equal(atSr('followersCount', 5), '5 пратилаца');
  assert.equal(atSr('matches', 2), '2 поготка');
  assert.equal(atSr('matches', 5), '5 погодака');
});

t('the three keys whose value already embeds {n} keep the number inside the phrase in every locale', () => {
  const keys = ['cookieCount', 'cookieCountWithSession', 'followersCount'];
  const bad = [];
  for (const [code, table] of Object.entries(PLURALS)) {
    const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const key of keys) {
      for (const c of cats) {
        const raw = table[`${key}_${c}`];
        if (typeof raw !== 'string' || !raw.includes('{n}')) bad.push(`${code} ${key}_${c}`);
      }
    }
  }
  assert.equal(bad.length, 0, bad.slice(0, 8).join('; '));
  const en = PLURALS['en-US'];
  assert.equal(countLabel(pickPlural(en, 'cookieCount', 'en-US', 1), 1), '1 cookie');
  assert.equal(countLabel(pickPlural(en, 'cookieCount', 'en-US', 3), 3), '3 cookies');
  assert.equal(countLabel(pickPlural(en, 'cookieCountWithSession', 'en-US', 3), 3), '3 cookies (incl. SESSDATA)');
  assert.equal(countLabel(pickPlural(en, 'followersCount', 'en-US', 1), 1), '1 follower');
  assert.equal(countLabel(pickPlural(en, 'followersCount', 'en-US', 3), 3), '3 followers');
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

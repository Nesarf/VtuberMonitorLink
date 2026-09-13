# English in the engineering layer

> This document is **English**, as is every other document under `docs/`. It defines which Chinese
> strings **in code** must become English and which must stay exactly as they are -- and which
> script guards that rule.

## 1. Three kinds of Chinese, three treatments

| Category | Example | Treatment |
| --- | --- | --- |
| **Engineering logic**: comments (`//`, `/* */`, JSDoc) | `// 基线的窗口不能锚在最后一次活跃那天` ("the baseline window must not anchor on the last active day") | **Change to English** |
| **Engineering output**: server logs, `console.*`, `process.stdout/stderr.write`, check names and details of tests and inspections | `log.info('抓取完成：12 条')` ("scrape done: 12 items"), `check('箱视角接口可用', …)` ("the agency-view endpoint is available") | **Change to English** |
| **UI and docs**: UI strings, error strings the API returns to the frontend, `docs/*.md` | the `zh:` dictionary in `web/src/i18n.jsx`, `res.json({ error: '还没有花名册…' })` ("no roster yet") | **Docs: change to English. UI strings: keep Chinese, do not touch.** |

The criterion in one sentence: **"UI copy meant for people" stays Chinese; "logic explanations meant for maintainers" becomes English.**

## 2. The easiest place to change the wrong thing

Chinese UI strings show up inside **comparisons and assertions**, where they are **data**, not output:

```js
// ✅ Keep: this asserts UI text
check('the group view block is rendered', main.indexOf('箱视角') !== -1);
assert.match(indexSummary(null), /尚未获取/);

// ✅ Change to English: this is read by whoever reads the logs
check('the group view block is rendered', ok, 'block present');
```

Likewise, the `zh:` dictionary in `web/src/i18n.jsx` and the key names passed to `t('...')` are UI
data: they are what the UI displays and what it is compared against, not engineering output, so they
stay Chinese. The same is true of `docs/` prose, except that it is reader-facing text rather than UI
data.
`README.zh-CN.md` is the only document in the repository that stays Chinese; every other document,
`docs/*.md` included, is English, because these files are read by people who do not read Chinese. The
only Chinese fragment that may still appear inside a doc is a quoted string kept as evidence. Inside
the UI, however, **do not change a single character** (changing it would scramble the UI in all 25
regions).

## 3. The guard script

```bash
node tools/english-logic.mjs          # Chinese comment/output strings -> exit 1 (runs in verify:fast)
node tools/english-logic.mjs --list   # list every hit per file (use as a worklist)
node tools/english-logic.mjs --json   # machine-readable
```

It scans `server/src`, `server/scripts`, `web/src` (skipping the string table itself, `i18n.jsx`, and
`locales/`), `tools/`, and `launcher/`, and decides two things:

1. **Comment text** must not contain Han characters (full-width punctuation `「」——·` counts too, and
   is converted to ASCII along with them);
2. **Output strings** must not contain Han characters -- every argument of `log.*` / `console.*` /
   `process.std*.write`, plus the **check name** (the first argument) of `check()/t()/ta()/note()/banner()`.

Arguments that take part in a comparison are skipped whole (`===` / `indexOf` / `matches` /
`includes` / `assert` …), so the "Chinese as data" pattern from section 2 above is not reported as a
false positive.

## 4. Grey area: **hard-coded product copy without a UI string** stays Chinese

Some Chinese strings are neither a `t('key')` UI string nor a log line -- they are hard-coded in the
server, but **end up rendered to the user**:

| Example | Destination |
| --- | --- |
| `reason` in `silence.js` ("X has had no new items for N days…") | **daily report markdown** + push body |
| `reason` in `notify.js` (`静默时段 22:00-08:00`) | settings page `🔕 正在静默 · …` |
| `hint` in `probe.js` ("direct is fastest (…)") | source-page toast and egress hint |
| `why`/`note`/`reason` in `egress.js` | tooltip of the automatic egress on the source page |
| `groupSignal.reason` in `groups.js`, the report block in `dormant.js`, `summary`/`reasons` in `watch.js` | daily report / watch history |
| the default task name `任务 N` ("task N") in `scheduler.js`, the `note` field in `live.js` | shown directly in the UI / returned with the API |

Criterion: **a string a user will see is product copy -> Chinese** (even when it does not go through
`t()`). Conversely, a string only logs / diagnostic reports / self-check output read -> English:
the summary line of `silenceSummary()` (read only by `log.*` and `/api/silence`, not rendered by the
UI), the skip reasons in `observe.js`, the diagnostic markdown `diagnose.js` generates, and so on.

One more thing lies outside the guard's boundary: **the guard only recognises `log/console/stdout` and
`check()/t()`**, so a string that is "put into an object and then printed by a log" (for example
`skipped.push({ error: … })`) is invisible to it. Decide those by this rule; do not count on the
script to catch them.

## 5. UI copy always goes through a UI string (this rule was added later)

**Any** text a user sees in the UI must have a `t()` key, even when it appears only once. The
counter-example is the 30 hard-coded Chinese strings that used to exist
(`直播中` / `来源 ↗` / `placeholder="要发的内容"` / `上次运行失败` …): they had no UI string, so all 25
regions **displayed Chinese** -- and in a Chinese environment that is impossible to notice.

Criterion: before you write a single Chinese character into a `.jsx` file, ask "does this UI string
exist".

## 6. Numbers + counters: use `tn()`, not `{n} ${t('word')}`

Quantity labels go through `tn('items', n)` (`web/src/plural.js` + `locales/plurals.js`), which picks
the word form via `Intl.PluralRules` -- `21 элемент` rather than `21 элементов`.
`t('key')` is for fixed copy only; `tn` is also counted by coverage / proofread stats (see BUGS #54).

## 7. Discipline while translating

- **Keep every "why"**: the comments here explain trade-offs and the pits that were stepped in
  (BUGS #NN, measured numbers, upstream behaviour). Translating is changing the language, not
  abbreviating. Information density must not drop.
- **Keep proper nouns as they are**: paths, identifiers, `BUGS #52`, `docs/OBSERVE.md`, endpoint
  names, platform names, measured numbers (`10035 条` / `0.54 MB` / `Bootstrapped 100%`) are not
  translated.
- **Do not change behaviour**: touch only comments and output text, not logic, not comparison
  literals, not key names, and do not reorder code.
- Once done, at least run `node --check <file>` (skip `.jsx`, which the final build validates).
- **Punctuation**: use the ASCII ` -- ` as the dash, not the CJK double dash; and do not leave
  circled digits (`①②`) behind -- both are in the guard's character class. A single em dash (`—`) is
  valid English and is not reported.
- **Comments are allowed to be wrong**: proofreading this round turned up several **factual errors**
  (claiming a UI feature that does not exist, calling a follow target a watch target, giving pax's
  record total length as a path length…). When you rewrite the wording and find the comment does not
  match the code, **flag it first**, and do not casually rewrite the comment to accommodate the code
  -- that turns a real problem into a smooth-sounding lie.

## 8. Commit messages are English too (added 2026-09-14)

**Why**: history is the first thing anyone sees when they open the repository. A body written only in
Chinese is unreadable to **the very people who would otherwise contribute** -- it cannot be searched,
cannot be cited, and gives a reviewer nothing to judge by. So this rule is set by "globally readable",
not by "I can read it".

- **Scope**: every commit message on every branch and every tag (both subject and body).
- **Criterion** (wider than the engineering layer; implemented in `tools/lib/cjk-text.mjs`): Han
  characters / kana / Hangul / CJK punctuation / full-width forms / circled digits / the translation
  pipeline's `⟦…⟧` sentinel / the CJK double dash. A single em dash is still valid English.
- **Allowed to remain**: original strings in other languages quoted as **evidence** (the Russian
  plural `Через {n} дн.`, the Arabic `بعد {n} يوم`, French word order) -- that is the data for "is the
  translation right", and deleting it deletes the evidence along with it. What is wanted is readable
  English, not pure ASCII.
- **How it is guarded**: `npm run commit-msg` (`tools/commit-msg-check.mjs`); `.githooks/commit-msg`
  blocks it once at local commit time; the `check` job of `ci.yml` scans the whole history with
  `fetch-depth: 0`. Enable the hook locally once: `git config core.hooksPath .githooks`.
- **Rewriting history**: this round's 14 Chinese bodies have been rewritten into English
  (`git filter-branch --msg-filter`, only the messages were replaced; tree / author / date /
  parent-child structure / signature status were compared commit by commit and left unchanged), then
  force-pushed. The record and the steps are in `docs/PUBLISH.md`.

# Release notes

## v1.0.2

**An egress that knows where it lands, a share flow that can be finished by hand, and checks that stopped lying
about their own input.**

82 commits since 1.0.1. Three threads run through them. The network layer learned to judge an exit by *where the
traffic comes out* and not only by how fast it answers. The share and login surfaces stopped being one button
and became stages a person can actually drive - including, explicitly, the sites this build cannot post to. And
the checks guarding all of it were repaired in several places where they had quietly stopped being true, which
is the part worth reading the "problems" section for.

### Added

1. **Egress locality, measured rather than assumed.** Each working egress's exit country is read through that
   egress itself (`probe.js` asks a trace endpoint), and the automatic decision applies it as a **weight**: a
   small bonus for landing in the country a source wants, a penalty for landing elsewhere, and a factor of
   exactly one when either side is unknown - so every earlier decision is unchanged. Sources can declare the
   region they want to appear from (three built-ins do, and it is editable in the list and when creating a
   source). Measured on the development machine: the direct egress lands in CN and the local proxy in JP.
2. **Trend ranges from thirty minutes to a year**: 30m / 1h / 4h / 12h / 1d / 3d / 7d / 30d / 90d / 180d /
   360d, with sub-day buckets computed in the report layer rather than in SQL, and the alerts series hidden
   where a range cannot carry it.
3. **A login state can be checked wherever it can be configured.** Five surfaces (Settings, Live, Sources,
   Watch, Share) each carry an always-present check that measures rather than assumes, tells the person what is
   missing when it cannot run, and never invents a pass. A new **Browser** page owns the browser and profile
   targeting for every consumer at once: it enumerates the profiles installed on this machine for one-click
   selection, shows a per-feature status table, and links from the results that complain about a missing
   setting. `privacy.anonymousMode` - documented as "never use a login", and until this release read by
   **nothing at all** - is now enforced inside the resolver.
4. **Sharing is three independent stages** (account / verification / send) with a declared profile per site:
   login kind, credential, named requirements, whether publishing is implemented, text and image limits, and a
   manual block. For everything this build cannot do, the page prepares instead: a hand-off with a compose link
   (offered only when the body fits that site's limit), copy, and a file - recorded in the audit as a hand-off
   and never as a post. Each site also has its own editable body with a live character counter and a way back to
   the prepared text, and a report can be opened in an editor straight from the list.
5. **The worker layer**: Perl, R and C# implementations joined it, macOS stopped being an informational CI leg
   and started gating, and the differential fuzzer reports an interpreter that is not on the machine instead of
   dying of it.
6. **The launcher answers a second launch** (opening the page and exiting 0 instead of reporting a port
   conflict), and when it does fail it prints where the reason is and waits for a key **only when a person is
   there** - a pipe, a service manager or CI is never blocked.
7. **Gates**: the release copy proves it came from this tree; the bug table is checked for contiguous numbering;
   `integrity-check` now constructs the application, refuses a route that reaches a helper before it is
   declared, checks that every `api.<name>()` the UI calls exists, and checks that one owner resolves the
   browser profile. `sanitize-check` no longer reports findings no one can act on.

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Fast self-check | `npm run verify:fast` | 22/22 steps, including every `tools/*-test.mjs` |
| Release traversal (packaged build: every route and error path) | `npm run traverse` | **85/85** |
| UI traversal (real browser, real collection against a mock LLM) | `npm run traverse:ui` | **237/237** |
| Flow traversal (webhook delivery, config round-trip, scheduled tasks, assistant) | `node tools/traverse-flows.cjs` | **33/33** |
| Pre-publish scan | `npm run sanitize-check` | no hard-coded paths or personal data |
| Locale coverage / proofreading | `locale-coverage` / `i18n-proofread` | coverage flat, proofread suspect count **below** its pinned baseline, structural problems 0 |
| Committed tree | a checkout of the release commit | the full suite, run inside it rather than in the tree it was written in |

### Problems found and fixed

The bug table grew from #71 to #90. Three are worth naming because of what they say about checking:

- **A privacy switch that did nothing** (#87): `privacy.anonymousMode` was documented, rendered, and read by no
  code anywhere in the repository. A promise to sit above every consumer needs a shared decision point, and
  there was none - the defect was not a missing condition but the absence of an owner. There is one now, and the
  switch is enforced inside it.
- **A check that lied about its own input** (#89): the integrity checker's string stripper treated an apostrophe
  inside a comment as the start of a string literal, so English prose swallowed the eleven dictionary keys that
  followed it and the checker reported a file of 260 keys as having 249. The same class appeared twice more the
  same day - a structural check tripped by the comment that explained it, and `git check-ignore`'s quoting of
  every Windows path silently disabling a skip.
- **A commit that was green everywhere except in its own checkout** (#84): every check ran in the working tree,
  where the generated dictionary was correct because it had been generated from the working tree's dictionary.
  The committed tree is a different input, and CI reported the difference. Releases are now verified from a
  checkout of the commit that is being released, which is where the numbers in the table above come from.

### Not yet verified

The same two as 1.0.1: sending danmaku from a real account and vision tagging with a real key need the user's own
credentials, so the self-checks use local fakes. In addition, this release does not attempt to publish to X,
YouTube, Weibo, Reddit or Mastodon - they declare what they need, their login state can be checked, and sending
reports honestly that it is not implemented - and the image attachment setting is page-level rather than a
per-site override.

---

## v1.0.1

**A bilingual manual that can be read inside the UI, with instant language switching.**

1.0.0 was the first release; this version completes the "documentation" story - the README used to be a single
bilingual bound volume, and reading it meant leaving the UI to go find a file, so the 1.0.0 exe had no entry
point for it either.

### Added

1. **Two READMEs**: `README.md` (English, shown by default on GitHub) and `README.zh-CN.md` (Chinese), each with
   a language cross-link at the top. The content is aligned - the English side gained the
   `界面语言与翻译管线` (UI language and translation pipeline) section that previously existed only in Chinese.
2. **The `关于` (About) panel in the UI**: a top-bar button opens an overlay that renders the whole document
   with the UI's own markdown renderer. **Switching between Chinese and English swaps in an already-fetched
   text** (both are cached in memory): no navigation, no refresh, no repeat request. The language follows the
   UI language by default and is independent afterwards; Esc or a click on empty space closes it.
3. **Endpoint `GET /api/readme?lang=en|zh`**: two fixed file names (no arbitrary paths accepted), an unknown
   language falls back to English, and it returns `available` so the UI knows how many language options to show.
4. Packaging side: both `app/README.md` and `app/README.zh-CN.md` ship in the package, and `verify-release`
   lists them as **required files**.

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Fast self-check | `npm run verify:fast` | all passed (26 steps) |
| README endpoint | `npm run traverse` | **85/85** (5 new: both languages returned and their content differs, `available` correct, unknown language falls back, body length sane) |
| UI panel | `npm run traverse:ui` | **210/210** (8 new: the button opens it, the body renders into real structure, both language options are present, the text really changes after switching, **no navigation**, no full-page refresh, Esc closes it) |
| i18n | `npm run i18n:coverage` / `i18n:proofread` | every shipped locale **638/638 = 100%**; proofread hard failures **0** |
| Release chain | `npm run release` | build ✓; proofread clean; both traversals passed |

### Not yet verified

Same as 1.0.0: sending danmaku from a real account and doing vision tagging with a real key both need the
user's own credentials, so self-checks always use a local fake service.

---

## v1.0.0 - first public release

**A local-web VTuber intelligence monitor: pick your own browser, pick your own sites, watch the people and pages you want to watch.**

There are only two user-facing artifacts, and both work straight after download:

```
VtuberMonitorLink-1.0.0-win-x64.zip     ~40 MB, unzip and double-click
  VtuberMonitorLink.exe                 single file, bundles the runtime, no Node install and no admin rights
```

> Version numbering note: development-period numbers are 1.0 -> 1.7.x (recorded under "History" below), and
> **the public release counts from 1.0.0 again** - the 1.0.0 on the download page is the first time this
> project's full capability set is public.
> The naming rule is fixed alongside it: **user-facing files use the full name `VtuberMonitorLink`, internal
> identifiers use the short name `VML`** (`npm run brand` checks this rule, see `tools/vml-brand.mjs`).

### What is in this version

| Capability | Key points |
| --- | --- |
| Thirty built-in sources | Reddit / Fandom / Moegirlpedia / Twitch / X / YouTube / Bilibili dynamics / each agency's official NEWS / merchandise platforms... tick them one by one, or add your own visually |
| Watch targets | Any web page / MediaWiki article / recent changes / watchlist / Bilibili dynamics; it says what changed and by how much, not just "it changed" |
| Follow by person | Local string matching attributes items to people, and hits carry evidence; one-click import from the VDB roster (multi-platform, circle dimension) |
| Event merging | IDF-weighted similarity + union single-link + time window, marking how many sources confirm an item |
| Agency view / silence hours / dormant | Circle heatmap and co-occurrence at the same moment; inactivity is judged by **each person's own cadence**; anyone quiet for >= 6 months goes to the end of the daily report |
| Observe mode | sampling + jitter + Tor only for the sites whose logs are held by the other side, reducing the traces of "someone swept the whole agency" |
| Push and silence hours | 12 channel types; notifications inside silence hours are queued and sent later instead of dropped |
| Reports and archive | SQLite incremental archive, inline SVG charts, anniversary countdown, one-click share as a single file, Word/Excel export |
| 28 locales | including RTL, locale-specific dates/numbers/first day of week, plural forms driven by `Intl.PluralRules` |
| Usage dashboard | accounting per call and per model, optional daily budget, over-limit calls can be blocked; calls that report no usage are counted separately |
| Desktop form factor | single-file exe + local web UI (`127.0.0.1:43110`), no dependency on any online service; LLM optional |
| Bilingual manual | `README.md` (English) and `README.zh-CN.md` (Chinese); **read directly from `关于` (About) in the top-right of the UI**, with instant language switching (overlay, no navigation, no refresh) |

### Added later: bilingual README + in-UI About panel

The manual used to be a single bilingual bound volume, and reading it meant leaving the UI to find a file. Now:

- **Two documents**: `README.md` (English, shown by default on GitHub) and `README.zh-CN.md` (Chinese), each
  with a language cross-link at the top. The content is aligned (the English side gained the
  `界面语言与翻译管线` (UI language and translation pipeline) section that previously existed only in Chinese).
- **Reading inside the UI**: the `关于` (About) button in the top bar opens an overlay that renders the whole
  document with the UI's own markdown renderer. Switching between Chinese and English **swaps in an
  already-fetched text** (both are cached in state): no navigation, no refresh, no repeat request. The language
  follows the UI language by default and is independent afterwards - someone using a Japanese UI may still want
  to read the Chinese one.
- **Endpoint**: `GET /api/readme?lang=en|zh` (two fixed file names, no arbitrary paths accepted; an unknown
  language falls back to English; returns `available` so the UI knows how many options to show).
- Packaging side: both `app/README.md` and `app/README.zh-CN.md` ship in the package, and `verify-release`
  lists them as required files - with one missing, the panel's language switch would have nothing to switch to,
  and that kind of gap is only discovered when the user opens it.

| Check | Result |
| --- | --- |
| README endpoint | traverse **85/85** (5 new: both languages returned, their content really differs, `available` correct, unknown language falls back, body length sane) |
| In-UI panel | traverse:ui **210/210** (8 new: the button opens it, the body renders into real structure, both language options are present, the text really changes after switching, **no navigation**, no full-page refresh, Esc closes it) |

### Pre-release checks (measured on 1.0.0)

| Check | Command | Result |
| --- | --- | --- |
| Fast self-check (26 steps) | `npm run verify:fast` | all passed |
| Naming consistency | `npm run brand` | internal identifiers **9/9** VML, user-facing artifacts **7/7** full name |
| English coverage | `npm run english` | engineering layer **100%** (5923 items: 3475 comment blocks + 2448 output strings, 0 Chinese); UI strings **100%** (25 locales x 633 keys) |
| No-traces | `npm run sanitize-check` + `npm run release` | no hardcoded paths / credentials / private names; release tree rescanned and passed |
| Release chain | `npm run release` | build ✓; proofread clean; endpoint traversal **80/80**; UI traversal **202/202** |
| Release package | `tools/make-zip.mjs` | package contains no `config.json` / reports / logs / roster cache |

### Install notes

- **No Node install needed** and no admin rights; unzip into any directory and double-click.
- Sources that need login (Bilibili dynamics with images, X body text, the Moegirlpedia watchlist) **are logged
  in by your own browser**; the program copies the cookie database read-only to obtain the login state, and
  never packages or uploads any account.
- Vision tagging (sending images to an external model) is **off by default**; LLM analysis and danmaku sending
  both require you to enable and confirm them explicitly.
- When packaging, postject prints `warning: The signature seems corrupted!` - its existing notice about the
  node baseline signature; `--doctor` and both traversals pass, so it is a known harmless warning.

---

## History (development-period numbering, not publicly released)

## v1.7.0

**Circle (agency) roster (multi-platform) + agency view / silence hours and dormant / observe mode / usage and budget.**

### Added

1. **VDB roster (`server/src/vdb.js` + `server/src/tar.js`, `从 VDB 导入关注对象` (import follow targets from
   VDB) on the follows page)**: `dd-center/vdb` (the upstream of vtbs.moe) is **one file per person** -
   multi-language names + per-platform accounts + circle.
   - **The whole database in one request**: the full-database tarball is **0.54 MB / 10035 records / 215
     circles** (measured), one `codeload` request; calling the GitHub API entry by entry takes thousands of
     requests and is noisier for both the user and the upstream. TTL 7 days, manual sync available.
   - **Platform-independent**: 27 platforms (bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico /
     showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon /
     line / github ...). Searching for an account id or a link form on **any platform** matches; the code has no
     "Bilibili only" branch.
   - **Import goes through the same sanitising path**: the record is first converted into the standard follow-target
     shape, then passed through the same `sanitizePerson()` as manual creation; rejected entries report their
     reason one by one (duplicate id, invalid alias, ...) instead of being dropped silently.
   - **Licence**: VDB data is **CC BY-NC-SA 4.0** (the code is GPL), and this project is MIT -> it is **fetched at
     runtime only**, cached under `app/vdb/`, and **never enters the repository and never enters the release
     package** (`.gitignore` + `make-zip` exclusion + `verify-release` check); both the UI and the docs give
     attribution. See `docs/VDB.md`.
2. **Agency view / silence hours and dormant / observe mode / usage and budget** (`silence.js` `groups.js` `dormant.js` `fetchplan.js`
   `cost.js` `observe.js`): design trade-offs are in `docs/DESIGN.md` §12-13, and the threat model plus measurements for observe mode are in `docs/OBSERVE.md`.
   - The silence criterion uses the **average interval** between recent active days rather than anchoring on the
     last active day; tolerance `interval x 2.5` (clamped to 3-90 days); a comeback requires recent activity plus
     a long preceding gap.
   - People quiet for >= 6 months: their latest content is listed together at the **very end** of the daily
     report (which keeps the report timely), and a sudden sign of activity is marked.
   - Fetch layer: grouped parallelism by egress (serial within a group + jitter), isolation after consecutive
     failures (default: 3 failures -> 6 hours of isolation), and a degradation ladder of fetch methods
     (API/RSS -> browser).
   - Usage: accounted per run and per model, the budget only warns by default, and only `onExceed='stop'`
     actually blocks; calls whose model reports no usage are counted separately.

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Fast self-check (22 steps) | `npm run verify:fast` | all passed - including entry-by-entry proofreading of 25 languages x 615 UI strings (structural breakage **0**, 17 suspicious entries recorded), 25 roster items, 5 hint-rendering guard items, 25 image-tagging items |
| Release-package proofreading | `npm run verify` | clean - 71 text files, 0 keys/personal paths, 0 runtime data, `app/vdb/` not in the package |
| Release zip | `tools/make-zip.mjs` | **1338 files / 40.3 MB**, runtime state excluded; spot checks confirm the package has **no** `app/config.json`, `app/vdb/`, `app/reports/`, `app/logs/` |
| exe self-check | `VtuberMonitorLink.exe --doctor` | All checks passed (sea=true, mode=inline) |
| HTTP endpoint traversal | `npm run traverse` | **80/80** - new section 8b `花名册` (roster): the status endpoint **answers offline**, carries source and licence attribution, does not stuff the whole database into the response, rejects an import with an empty selection, and rejects a key missing from the roster with a reason |
| UI traversal | `npm run traverse:ui` | **202/202** - a real browser walked all eleven pages plus one real run with a mock LLM (20 entries into the intel feed); new render assertions for the roster block and the agency-view heatmap; 0 console errors, 0 failed API calls |
| Roster real data | measured during development | upstream tarball **0.54 MB -> 10035 records / 215 circles** (1770 records have a circle, 17.6%); reconciled against `tar.exe`, entry count matches the upstream file count |

### Added later: engineering layer in English + plural forms

> The user asked to "make the engineering logic fully English", with this boundary: **comments, server logs,
> test and inspection output** move to English;
> **UI strings, API error strings, `docs/*.md`, and any product copy the user sees (daily report / push / UI
> hints) stay Chinese**.
> The rule is written down in `docs/ENGLISH-LOGIC.md` and enforced into `verify:fast` by `tools/english-logic.mjs`.

| Check | Command | Result |
| --- | --- | --- |
| Engineering-layer language guard | `node tools/english-logic.mjs` | **clean** (118 files scanned; no Chinese in comments or output strings) |
| Plural-form self-check | `node tools/i18n-plural-test.mjs` | **27/27** - includes a completeness ratchet: every category a language uses must have a form |
| Hint-rendering guard | `node tools/hint-md-test.mjs` | 5/5 |
| Entry-by-entry proofreading | `node tools/i18n-proofread.mjs` | 25 languages x 615 UI strings, **structural breakage 0**, 17 suspicious entries (recorded) |
| Fast self-check (25 steps) | `npm run verify:fast` | all passed |
| Release chain | `npm run release` | build-portable ✓; verify-release **clean** (72 text files); traverse **80/80**; traverse:ui **202/202**; zip **1339 files / 40.3 MB** |

Real problems fixed along the way in this batch (details in `docs/BUGS.md`):

1. **The Arabic UI really did display `⟦n⟧`** (BUGS #64): sentinel detection in the pipeline only recognised
   `⟦数字⟧` (digit sentinels), so sentinels carrying a **name** went all the way into `machine.json` and were
   shown to the user. Both detectors - in `i18n-proofread.mjs` and `i18n-translate.mjs` - are now relaxed to
   "any `⟦…⟧`"; the two were asymmetric before (proofreading matched digits, and the translation-time gate
   matched digits as well).
2. **The guard script itself had two blind spots** (BUGS #65): `log?.info(...)` did not match, and quotes inside
   a regex literal made the character scan **lose sync** (every Chinese comment after that point went
   unreported). After the fix it immediately reported 6 previously invisible Chinese spots. A named escape
   hatch `english-logic:allow` was added, for the one case where a comment must quote the CJK characters
   themselves.
3. **The "slug is stable" assertion in `vdb-test` failed intermittently** (BUGS #66) - it called `slug('')`
   twice and compared, while the fallback id for an empty name deliberately carries a timestamp (to avoid
   collisions), so **it looked like a determinism test but was actually testing the clock**. It now asserts the
   real contract: a non-empty name must be stable, and an empty name returns a valid shape.
4. Plural forms (originally BUGS #54, fixed): `21 элементов` -> `21 запись/записи/записей`, and the English
   `1 items` was fixed at the same time. The approach is in `docs/DESIGN.md` §11.

### Added later: missing UI strings + English comment review

> That English round **touched only the engineering layer**, so 30 hardcoded Chinese strings in the UI stayed
> where they were - they had no `t()` keys, and all 25 locales showed Chinese. This round turned every one of
> them into a UI string (the zh copy is unchanged character for character, so neither the Chinese UI nor the
> inspection assertions are affected).
> At the same time, the English comments of 68 files were reviewed by sampling, and translationese and factual
> errors were fixed.

| Check | Command | Result |
| --- | --- | --- |
| Hardcoded Chinese in the UI | script scan of `web/src/**/*.jsx` (the UI string definitions themselves excluded) | **0** (was 30) |
| Locale coverage | `node tools/locale-coverage.mjs` | 25 locales **633/633** (20 new UI strings, the machine layer is complete; the denominator dropped from 635 to 633 because the keys `peopleItems` / `chartsDays` were taken over by plural-aware shared keys and are no longer "keys the UI uses" - every locale is still 100%) |
| Plural forms | `node tools/i18n-plural-test.mjs` | **31/31** - the form table grew from 5 keys to 13 keys (new `groupMembers`/`groupPeopleCount`/`costCalls`/`matches`/`alerts`/`cookieCount`/`cookieCountWithSession`/`followersCount`), 11 locales with plural variation produce 296 new forms, and the completeness ratchet covers new keys automatically |
| Entry-by-entry proofreading | `node tools/i18n-proofread.mjs` | structural breakage **0**, 18 suspicious entries (recorded; the new one is a Korean translation shorter than the Chinese source, a heuristic false positive) |
| Engineering-layer language guard | `node tools/english-logic.mjs` | clean (the character class now covers CJK double dashes and circled numbers, see BUGS #65) |
| Fast self-check | `npm run verify:fast` | all passed |
| Release chain | `npm run release` | build-portable ✓; verify-release **clean**; traverse **80/80**; traverse:ui **202/202** |

Real problems from this round (details in `docs/BUGS.md` 68-70):

1. **The non-JSON branch in `danmaku.js` referenced a variable that does not exist** (BUGS #68): the `text` in
   `text.slice(0,200)` did not exist in that scope at all, and the ReferenceError was swallowed by the catch -
   what the user saw was `text is not defined` instead of the real Bilibili reply. This was found while reading
   the comments of one file after another; `node --check` cannot see it.
2. **The account id leaked the profile path prefix** (BUGS #69): the comment said "short hash", while the code
   was a truncated base64url encoding (reversible) that was returned to the front end by the endpoint. It is
   now a real sha256 digest; the double parentheses caused by the UI wrapping the server's
   `（设置里指定的）` (specified in settings) in another pair were fixed along the way.
3. **Three assertions that were always true** (BUGS #70): comparing something to itself, `|| true`, and the
   tautology that "two elements can only be 1 or 2 clusters"; another one handed an `async` callback to a
   synchronous runner, so a failure became an unhandled promise rejection. The green report was lying - all of
   them are now real assertions.
4. Factual errors fixed during the comment review: `cost.js` claimed "the UI previously had no usage at all"
   (it actually has `/api/cost`); `runner.js` wrote "watch target" where it meant "follow target"; `config.js`
   claimed people who stopped being active "do not appear" (they appear at the end of the daily report, which is
   exactly the point of that block); `tar.js` described pax's "total record length" as "path length"; a comment
   in `live.js` said 100 while the code batches by 50; the JSDoc in `probe.js` was missing the `tor` tier.

### Problems found and fixed during proofreading

1. **`**bold**` in a hint was displayed as literal asterisks** (BUGS #61): the copy contained markdown markers
   while the render site was plain text. This is a **recurrence** of BUGS #52 - at the time only the six broken
   places were changed to `<Inline>`, with no assertion left behind. Now there is one:
   `tools/hint-md-test.mjs` requires that "for a key whose value contains markers, every call site must have
   `Inline` on the same line", checks the reverse as well ("no markers at a plain-text render site"), and
   verifies that the zh/en markers match; a **mutation test** confirmed this assertion really does fail.
2. **An image-tagging failure was just one number** (BUGS #63): `tagItems()` now returns `errors` (up to 5, with
   url and reason); it also retries once only for **transport-layer** errors (HTTP 5xx/401 and parse failures
   are **not** retried), and records "retried once" faithfully in `retried`.
   The root cause is still to be reproduced (a stale socket reused by keep-alive was suspected, but a
   reproduction script ran 3 rounds with all of them succeeding, so that hypothesis is ruled out).
3. **One traversal could leave the previous round's app behind**: when a process has just been killed the port
   is not necessarily released immediately, so the next traversal may talk to a leftover instance - and the
   symptom drifts to places that look unrelated, such as "0 reports".
   Starting the app now waits for the port to be genuinely free and asserts that "the process answering is the
   one we just started", then waits for it to really exit when tearing down.
4. **Mojibake while reconciling against `tar.exe` once made me suspect my own tar reader** (BUGS #62): in fact
   `tar.exe` decodes file names using the local code page on Chinese Windows; we decode explicitly as UTF-8,
   and **we were right**.

### Not yet verified

- **The roster really downloading once inside the packaged app**: the traversal deliberately verifies only that
  it "answers offline" (no network, repeatable); the real download and parse ran during development on the same
  code (the 0.54 MB / 10035 records above), but it has not been run again in the release build.
- **Vision tagging with a real key**, and **sending danmaku from a real account**: both need the user's
  credentials, so self-checks always use a local fake service.
- When packaging, postject prints `warning: The signature seems corrupted!` - this is its existing notice about
  the node baseline signature, the injection succeeds, and `--doctor` plus both traversals pass; it is a
  **known harmless warning**, not a corrupted artifact.

---

## v1.4.0

**Local intel search (no LLM needed) + self-check moved to the end of a run + syntax self-check for bundled scripts.**

### Added

1. **Intel search page (new `检索` (Search) tab)** (`server/src/search.js`):
   **purely local matching - no LLM and no network needed**, it works with no AI configured, and the idea is the
   same as searching papers or pressing Ctrl+F in a browser.
   - keywords (space-separated as AND), **search scope** (all fields / title / body / tags / source / link);
   - **tag facets**: clickable like the left-hand side of a paper search, multiple tags are AND; clicking again
     removes the tag;
   - **time range**: last 7 / 30 / 90 days / last year / custom start and end dates;
   - **alias expansion**: the vocabulary maps `2434 = にじさんじ = 彩虹社 = nijisanji` (Nijisanji),
     `马车 = マリオカート` (Mario Kart) ..., so typing one word matches every spelling; the vocabulary can be
     edited in `feeds/tags.json`;
   - **facet counts**: hit counts for tags / sources / categories / months, so you know where to narrow;
   - the number of entries excluded by the time condition is reported separately
     (`不是没搜到，是被时间挡了` - "it was not a miss, it was blocked by time").
2. **`帮我认人` (help me identify this person) assistant (optional, needs an LLM)**: for when you remember the
   traits but forgot the name (appearance / voice / famous moments / affiliation). With no LLM configured it says
   plainly `用不了` (not available), without affecting ordinary search.
3. **Self-check moved to the end of a run** (corrected on request): adding a custom source **no longer** triggers
   an immediate self-check. The **last step** of every run now diagnoses the sources that went wrong in that run
   and writes a diagnostic file, and the diagnostic link is sent out together with the alert push. Sources that
   connect normally are not disturbed at all.
4. **Syntax self-check for bundled scripts** (step 4 of `npm run verify`): runs `node --check` over every bundled
   `.js/.cjs/.mjs`.
5. **API errors now always return JSON**: a throw inside a route used to return Express's HTML error page, so the
   front end's `JSON.parse` only ever produced `Unexpected token '<'`, which was very hard to diagnose;
   everything is now converted to JSON and logged.

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Source privacy self-check | `npm run sanitize-check` | clean |
| Release-package proofreading | `npm run verify` | clean (including the new "syntax self-check for 31 scripts" item) |
| HTTP endpoint traversal | `npm run traverse` | **73/73** |
| UI traversal | `npm run traverse:ui` | **61/61** (new search section: keyword hit, empty query, time range, source filter, alias expansion, vocabulary and automatic tags) |

### Problems found and fixed during proofreading

1. **`3D披露` / `2434` used as object keys without quotes** (`3D披露` = 3D reveal) - a key starting with a digit
   is not a valid identifier, so `search.js` failed on load and the packaged exe would not start
   (`Invalid or unexpected token`). Quotes were added, plus the new "bundled-script syntax self-check" gate, so
   **this class of error can no longer ship**
   (the packaging script only looks at the exe's `--doctor`, and at that point the broken module has not been
   loaded yet, which is why it was missed).
2. **The search route was missing an import**, so Express threw and returned an HTML page - as above, a JSON
   error fallback was added.
3. **Bilibili image dynamics without login had no publish time** (`pub_time` empty), so setting any time range
   excluded the whole batch. They now fall back to "first seen in which run" and mark the source
   (`tsSource: item|run`), so time filtering works for these entries too.
4. **`outsideTimeRange` was too narrow in meaning** (it counted only when there was no time at all); it now means
   "entries excluded by the time condition", which is what the user actually wants to know.

---

## v1.3.0

**Site connectivity visualisation + scheduled tasks in the web UI + alert push + layout DIY + site thumbnails + custom-site self-check.**

### Added

1. **Per-site live connectivity data** (`server/src/probe.js`): each source page shows two badges under every
   site - the latency and failure rate of `直连` (direct) and `代理` (proxy) - plus a conclusion of
   "suggest direct / suggest proxy / neither egress works".
   - the direct probe measures **TCP handshake time** (the closest thing to ping); the proxy probe measures
     **time to first byte of a request through the proxy**;
   - "failure rate" = failures / attempts, and both the UI and the docs use that definition rather than
     pretending to be ICMP packet loss;
   - results are cached for 30 minutes (configurable), so opening the page does not hit the sites every time.
2. **Per-site egress switch**: any source (including built-in ones) can be set individually to `跟随全局` /
   `强制直连` / `强制代理` (follow global / force direct / force proxy).
3. **Automatic egress failover**: when a source has no explicit egress, a failure automatically retries once
   over the other path and the result marks `failover from→to`. Sources with an explicit egress (Bilibili, for
   example) are never changed automatically.
4. **Site health dashboard**: one screen summarising the latency / failure rate / last run result of enabled
   sources, with "problem sites" listed separately.
5. **Scheduled tasks (in the web UI)** (`server/src/scheduler.js`, rewritten): you can create multiple tasks,
   each with its own mode (`常规` (normal) / `通贩` (merchandise) / `只检查监视对象` (watch targets only)),
   frequency (a weekday / daily), time, and whether to catch up; it shows the next run plus the following 3
   previews, the last run time, and the execution history. A task missed while the program was closed runs once
   after startup.
6. **Alert push** (`server/src/notify.js`): Bark / `Server酱` (ServerChan) / Telegram / Discord /
   `飞书` (Feishu) / custom Webhook, each channel with optional trigger conditions (push every time / alerts
   only / failures only). A summary is pushed when a run ends, and watch alerts and keyword hits take priority.
   A single test message can be sent from the web UI.
7. **Site thumbnails** (`server/src/thumbs.js`): images are fetched in the order `og:image` ->
   `apple-touch-icon` -> `/favicon.ico`, cached locally under `thumbs/`, and the web UI reads the local cache
   (so it does not hit the site again and it bypasses hotlink protection and cross-origin limits).
   You can also click `截图` (screenshot) to render a real page screenshot with the browser.
8. **Custom-site self-check** (`server/src/diagnose.js`): adding a custom source triggers one automatic
   self-check. **If it connects, it is left alone**; only a clear anomaly produces a human-readable diagnostic
   file (conclusion / measured data / raw error / suggested items to investigate), and clicking it under
   `诊断文件` (diagnostic files) in the web UI opens a readable page.
9. **Layout DIY** (`web/src/layout.js`): card wall (a multi-column wall of entry tiles) / list / compact /
   timeline / table; column count, density, font scaling, theme colour and which
   fields to show are all adjustable, effective immediately.
10. **Intel starring and read state**, **this run vs last run comparison** (added / changed / disappeared),
    **line-by-line report comparison**.
    Entry ids are now content-derived, which is what lets stars survive across runs.
11. **Proxy node panel** (`server/src/proxyctl.js`): reads the node list from a local mihomo / Clash, measures
    **the latency from each node to the site you specify** (the kernel's latency endpoint accepts a URL itself),
    and switches with one click.
12. **Config import/export**: export to JSON either sanitised (default) or including keys, and import on another
    machine with one click; an empty string does not overwrite an existing key.
13. **Anonymous mode**: uses no login state at all (does not read browser cookies, does not reuse a profile);
    enable it when preparing to publish.

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Source privacy self-check | `npm run sanitize-check` | clean |
| Release-package proofreading | `npm run verify` | clean |
| HTTP endpoint traversal | `npm run traverse` | **73/73** |
| UI traversal | `npm run traverse:ui` | **48/48** |

### Problems found and fixed during proofreading

1. **React #310 (hooks order mismatch)**: a `useState` added to the settings page sat after
   `if (!cfg) return <Loading/>` - 10 hooks on the first frame and 16 once the data arrived, so React unmounted
   the whole tree and the page went blank. All hooks were moved above the early return.
2. **A 404 thumbnail was treated as a failed request**: "this site has no usable thumbnail" is a normal result,
   so it now returns 200 + `{ok:false}`; otherwise the "no failed requests" assertion in the traversal would
   report false positives.
3. **Ambiguous selectors in the UI traversal**: diagnostic file names contain the source id, so the assertion
   "after deleting a custom source the page must not show that id again" failed forever; it now asserts against
   the endpoint and targets the delete button on that exact row.

---

## v1.2.0

**Login state no longer requires closing the browser**, and Bilibili dynamics with images now work out of the box.

### Added

1. **Read-only cookie extraction** (`server/src/cookies.js`): the browser's cookie database is copied and then
   decrypted, so it can be read while the browser is open, with **no locking and no changes to the original
   profile**. Measured on Opera / Chromium 130+: the `v10` scheme (AES-256-GCM + DPAPI) can be decrypted, and
   the 32-byte domain-binding hash that Chromium 130+ adds is stripped automatically.
2. **Chrome 127+'s App-Bound Encryption is recognised explicitly** (`v20` / `app_bound_encrypted_key`), with an
   actionable alternative instead of a silent failure.
3. **`POST /api/cookies/check`** and `设置 -> 浏览器 -> 检查登录态` (Settings -> Browser -> Check login state):
   reports only the **names** and counts of the cookies it read, and **never returns values**.
4. **Improved parsing of full Bilibili dynamics**: `feed/space` now passes `features=itemOpusStyle`, raising body
   coverage from 3->11 (`泠鸢`, Lingyuan) / 0->7 (`嘉然`, Jiaran); the original text of a repost is concatenated
   into the body as well.
5. `bili-dynamic-login`'s default uid is now **an UP who really does post images**, so the "with images" feature
   is visible out of the box (measured: 7/12 entries have images, 11/12 have body text, 12/12 have a publish
   time).

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Source privacy self-check | `npm run sanitize-check` | 57 text files, 0 hardcoded paths / keys / private names |
| Release-package proofreading | `npm run verify` | clean |
| HTTP endpoint traversal | `npm run traverse` | **73/73** (new contract checks for login-state probing and a "never returns values" assertion) |
| UI traversal | `npm run traverse:ui` | **48/48** |
| Real login state end-to-end | manual script | login state identified as `Nesarf_Mollor`; `feed/space` went from `-352` to `code=0`; 7 of 12 dynamics have images; **no cookie value appeared** in `feeds/` or in the reports |

### Problems found and fixed during proofreading

1. **The missing `features=itemOpusStyle` dropped all body text**: without this parameter, new-style image
   dynamics have an empty `major.draw.items` and a null `desc`, so not one body text could be retrieved. A
   comparison confirmed that adding it leaves the image count and URLs completely unchanged and only fills in
   the body.
2. **The wrong discriminator field**: `it.type` is sometimes `DYNAMIC_TYPE_DRAW` while the real structure sits
   in `major.type`.
3. **Reposted dynamics had empty content**: the body lives in the reposted `orig`, and it is now concatenated.
4. **The default demo source was a poor choice**: it pointed at an UP who only posts emoji codes, so the
   "with images" feature was invisible out of the box; it now points at an UP who posts images.

---

## v1.1.0

Feature-expansion release: **LLM selection and intel presentation inside the web UI, custom watch targets, Bilibili added as an intel source**.

### Added

1. **Multiple LLM profiles**: 9 provider presets (DeepSeek / OpenAI / Kimi / `智谱` (Zhipu) / `通义` (Tongyi) /
   SiliconFlow / OpenRouter / local Ollama / custom), which can be added, edited and deleted in the web UI and
   switched at any time; "fetch model list" and "test connectivity" are supported; the key is shown in plaintext
   only on the settings page when needed, and endpoints always return a masked value. An older flat config is
   upgraded automatically into a single profile, with no manual file editing.
2. **Intel card feed** (new `情报` (Intel) tab): the entries of the most recent run are filtered by
   source/keyword and laid out as cards, Bilibili images are shown inline (`referrerPolicy="no-referrer"`
   bypasses hotlink protection), `[表情]` (emoji) is marked separately, and entries that hit an alert keyword
   are tagged.
3. **Watch targets** (new `监视` (Watch) tab, modelled on Moegirlpedia's watch technique): five kinds of target -
   any web page, a MediaWiki article, MediaWiki recent changes, a MediaWiki watchlist (BotPassword login),
   Bilibili dynamics. It includes Moegirlpedia's alert rules (big edit / big deletion / new page / anonymous
   edit / unreviewed / log type / suspicious keyword), line-level diffs (with context fragments), change history
   and baseline management. The first check only establishes a baseline and raises no false alerts.
4. **Bilibili intel sources**: 5 new sources. The login-free `opus/feed/space` is the main one (image dynamics,
   with body text and like count), while the full dynamics that need login (with images) go through browser
   rendering. See the README for details.
5. **Per-source network egress**: sources and watch targets can be set individually to follow global / force
   proxy / force direct; loopback addresses are always direct (a local Ollama is never blocked by the proxy).
6. **Upgraded report page**: a hand-written Markdown renderer (escape first, then allow self-produced tags;
   never perform dangerous injection), rendered/raw dual view, full-text search, single-file HTML and JSON
   export.
7. **Custom sources**: add and delete RSS, MediaWiki, Bilibili UID, browser-rendered and other sources visually
   in the web UI.
8. **UI**: dark / light / follow system theme (effective on save); a desktop notification when a run ends.
9. **Local mock LLM** (`npm run mock-llm`): OpenAI-compatible, zero dependencies, lets the whole chain run
   end-to-end without spending money or entering a key, and doubles as the test double for automated traversals.

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Source privacy self-check | `npm run sanitize-check` | 56 text files, 0 hardcoded paths / keys / private names |
| Release-package proofreading | `npm run verify` | clean - all required files present, all text valid UTF-8, `README.txt`/`package.json` pure ASCII, 0 runtime data (including the new `watch/`) |
| exe self-check | `VtuberMonitorLink.exe --doctor` | All checks passed (sea=true, mode=inline) |
| HTTP endpoint traversal | `npm run traverse` | **70/70** - new stages for LLM profiles, watch-target CRUD and baselines, intel feed filtering, report search and export, custom sources |
| UI entry-by-entry proofreading | `npm run i18n:proofread` | **565 UI strings x 25 locales, structural breakage 0** - placeholders / bold markers / newlines / leading and trailing spaces / leftover sentinels compared against the source string one by one; 14 suspicious entries (recorded, must not grow) |
| UI traversal | `npm run traverse:ui` | **184/184** - a real Chrome walked six pages; one real run with a mock LLM (**20 Bilibili dynamics into the intel feed**), verifying that Markdown renders into real elements, exports are downloadable, **the dark theme is the default** (including switching to light and remembering the choice), no Chinese left in the Korean UI, desktop notifications present, 0 console errors, 0 failed API calls |
| Fetch-layer smoke test | `npm run smoke` | 2/2 (Reddit `.rss`, Fandom MediaWiki API) |

### Problems found and fixed during proofreading/traversal

1. **`docs/PUBLISH.md` hardcoded a local absolute path**, and it gets copied into `app/docs/` and shipped with
   the release package. It now uses a `<repo>` placeholder, and the file is included in the release proofreading
   scope.
2. **The private-name list appeared in a bundled file again** (this time in the rule table of
   `tools/verify-release.cjs`) - the same class of mistake as `sanitize-check.mjs` in the previous release; both
   now read `.sanitize-names`.
3. **Loopback addresses were handed to the proxy**: a local Ollama / mock LLM got blocked by the proxy; a hard
   rule now always uses a direct connection.
4. **The `cadence` field was unclear in meaning** (left over from the previous release): `effectiveSources` now
   states it explicitly for every source.

### Not yet verified

- **A full run with a real LLM key**. Automated flows always use the mock LLM; a real key should only exist on
  the user's own machine. The no-key degraded path is verified: preflight returns `未配置 API Key` (API Key not
  configured) immediately, the status becomes `failed`, and no half-finished report is produced.
- **Full Bilibili dynamics with images**: this needs a browser profile logged into Bilibili, and the local Opera
  has no Bilibili login state, so the path was only verified for "blocked with a clear message when not logged
  in", not for a normal response after login.
- **The Moegirlpedia watchlist**: needs a BotPassword, and here too only parameter validation and the failure
  hint were verified. Moegirlpedia itself (`zh.moegirl.org.cn`) is behind Cloudflare, so the most recent
  verification used Fandom's MediaWiki API.
- Pages behind Cloudflare protection (Fandom `Special:`, dic.pixiv.net) are still blocked in a headless browser.
- For Reddit only `.rss` works, and it is rate-limited per IP (about 1 request/30 seconds); reusing login state
  requires the target browser to be fully closed.

---

## v1.0.0

Single-file exe release. Double-click to use: no Node install, no admin rights, no command line.

### Artifacts

```
dist/VtuberMonitorLink/
  VtuberMonitorLink.exe     Node SEA single-file launcher (embeds the Node 24 runtime, 89 MB)
  package.json              the launcher reads the version number from here
  README.txt                pure ASCII quick start (displays correctly under any code page)
  app/                      the program itself
    server/                 backend (Express) + production dependencies node_modules/
    web/dist/               built front end
    docs/ README.md LICENSE config.example.json
dist/VtuberMonitorLink-1.0.0-win-x64.zip   distributable archive
```

The whole folder is about 112 MB (89 MB of which is the runtime embedded in the exe). You can move or rename it
freely, but **the exe has to stay next to `app/`**.

### CLI

```
VtuberMonitorLink.exe --help      show all options
VtuberMonitorLink.exe --doctor    self-check: runtime / program directory / front-end build / config
VtuberMonitorLink.exe --paths     print the paths actually resolved
VtuberMonitorLink.exe --port 8080 use a different port
VtuberMonitorLink.exe --no-open   do not open the browser automatically
```

### Verification evidence

| Check | Command | Result |
| --- | --- | --- |
| Release-package proofreading | `npm run verify` | clean - all required files present, all 30 text files valid UTF-8, `README.txt`/`package.json` pure ASCII, 0 keys/personal paths, 0 runtime data |
| exe self-check | `VtuberMonitorLink.exe --doctor` | All checks passed (sea=true, mode=inline, appRoot/webDist correct) |
| HTTP endpoint traversal | `npm run traverse` | **39/39** - static layer and SPA fallback, config read/write round trip, field contracts and list counts of 24 sources, browser/proxy probing, report list and 404, path traversal rejected, preflight, run state machine, unknown `/api/*` returns a JSON 404 |
| UI traversal | `npm run traverse:ui` | **25/25** - clicked through the four pages Run / Sources / Settings / Reports in a real Chrome: checkbox persistence, the API Key input masked and not pre-filled, proxy probe button, switching between Chinese and English, 0 console errors, 0 page exceptions, 0 failed API calls |
| Fetch-layer smoke test | `npm run smoke` | 2/2 succeeded (Reddit `.rss` 43997 B, Fandom MediaWiki API 7714 B) |

### Problems found and fixed during proofreading/traversal

1. **The SEA entry must be CommonJS**: an ESM entry makes Node 24's SEA report
   `Cannot use import statement outside a module` outright. The launcher was changed to `launcher/launch.cjs`.
2. **`--port` / `--no-open` did not work in inline mode**: the environment variables were only passed to the
   "spawn a child process" branch, while a same-process run needs them written back to its own `process.env`.
3. **Unknown `/api/*` was swallowed by the SPA fallback as `200 + HTML`**: callers treated the HTML as success.
   An `/api` fallback now sits before the static layer and returns a JSON 404.
4. **The `cadence` field of the source list only appeared on merchandise sources**: consumers had to guess by
   checking "not equal to merch". Every source now states `daily` / `merch` explicitly.
5. **Packaging copied the repository-root `package.json` into the artifact**: it declared npm workspaces, so
   `npm install` hoisted every dependency (including the front-end toolchain) into `app/node_modules`; its
   description also contained a non-ASCII dash. A dedicated pure-ASCII manifest is generated instead.
6. **The privacy self-check script was itself a leak source**: `sanitize-check.mjs` and `verify-release.cjs`
   hardcoded private character names / account names, so distributing them meant giving the names away. They now
   read from `$SANITIZE_NAMES` or from the gitignored `.sanitize-names`.

### Not yet verified

- **One complete real run** (fetch -> LLM analysis -> report) needs the user's own LLM API key.
  That key should exist only in `app/config.json` on the user's machine, is deliberately kept out of every
  automated flow, and is not pre-filled in the release package (the UI traversal asserts that the input is
  empty).
  The no-key degraded path is verified: preflight returns `未配置 API Key` (API Key not configured) immediately,
  the run status becomes `failed`, and no half-finished report is produced.
- Pages behind Cloudflare protection (Fandom `Special:`, dic.pixiv.net) are still blocked in a headless browser,
  so they need the MediaWiki API or a manual login state.
- Reddit blocks both the browser and `.json`; only `.rss` works, and it is rate-limited per IP (about
  1 request/30 seconds).
- Reusing login state requires the target browser to be **fully closed**, otherwise the profile stays locked.

### Known trade-offs

- The exe is two parts, "launcher + `app/`", to avoid a second 90 MB runtime (`--with-runtime` brings it back, at
  the cost of doubling the size).
- If the system has no Chrome/Edge/Opera, choose `随包 Chromium` (bundled Chromium) under
  `设置 -> 浏览器` (Settings -> Browser); the first run downloads the kernel. You can also pre-pack it into
  `pw-browsers/` with `npm run build:portable`.

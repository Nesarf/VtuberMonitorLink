# Design

> Vtuber's Monitor Link - a local-web VTuber intelligence monitor.

## 1. Overall architecture

```
 launcher.exe
      │  start the local server + open the default browser
      ▼
 http://127.0.0.1:<port>   <- loopback only, never exposed
      │
      ├─ Web UI (React + Vite)      configure / run / reports
      └─ Backend (Node)
           ├─ config.js    config read/write (every path and secret lives here)
           ├─ net.js       network layer: proxy (Node fetch does not read the system proxy by default)
           ├─ sources.js   source adapter catalogue (declarative)
           ├─ fetchers/    rss / mediawiki-api / browser / search-only
           ├─ digest.js    raw feed -> condensed digest (token control)
           ├─ analyze.js   LLM analysis (OpenAI-compatible)
           ├─ runner.js    orchestration: preflight -> fetch -> write feeds -> analyze -> write report
           ├─ scheduler.js built-in scheduler
           └─ reports.js   report and run-record storage
```

## 2. Three "user-configurable" designs

### 2.1 Browser

| Mode | Implementation |
| --- | --- |
| `bundled` | use the Chromium that ships with Playwright, works out of the box |
| `system` | `detectBrowsers()` probes an installed Chrome / Edge / Opera / Brave / Vivaldi |
| `custom` | the user supplies an executable path |

To reuse a logged-in session, fill in `profileDir` as well (that browser's user-data-dir).
Note: **that browser must be closed**, otherwise the profile is locked.

### 2.2 Sources (declarative adapters)

```js
{
  id: 'reddit-Hololive',
  category: 'community',
  fetch: 'rss',                    // rss | mediawiki-api | browser | search-only
  url: 'https://www.reddit.com/r/Hololive/.rss',
  login: 'none',                   // none | optional | required
  rateLimit: { gapSeconds: 35, retries: 1 },
  defaultEnabled: true,
}
```

What `fetch` means:

| Value | Purpose | Lesson from real use |
| --- | --- | --- |
| `rss` | Atom/RSS subscription | on Reddit only `.rss` works; rate limiting is per IP, so **deliberately spacing requests out** beats hammering retries |
| `mediawiki-api` | MediaWiki API | Fandom's `Special:RecentChanges` is blocked by Cloudflare, the API goes straight through |
| `browser` | browser rendering | SPAs (Twitch/X) and Cloudflare-protected sites (Moegirlpedia) have to go through a browser |
| `search-only` | handed to the analysis layer to search | YouTube, Fanbox, BOOTH etc. have no stable directly scrapable endpoint |

### 2.3 Login requirements

| Value | UI appearance | Example |
| --- | --- | --- |
| `none` | green | Reddit, Fandom, the official NEWS sites |
| `optional` | yellow | Twitch (shows `正在关注`, the "following" list, once logged in) |
| `required` | **red** | X/Twitter (logged out you only get a login wall) |

**Login always happens in the user's own browser; the tool only borrows the profile and never bundles or uploads credentials.**

## 3. Network layer and proxy

Measured result: **Node's `fetch` (undici) does not read the system proxy by default**, so on a network where direct connections are blocked it gives `ECONNRESET` / connection timeouts.
So `net.js` makes the proxy explicit configuration:

- Node-side fetching -> undici's `ProxyAgent` + `setGlobalDispatcher`
- browser rendering -> Playwright's `proxy` option

The UI can probe the common local proxy ports: it tries them one by one and fills in a working address (nothing is hard-coded to a single value).

## 4. Reports and cadence

- regular scan (weekly by default) -> `reports/<date>.md`
- merchandise/paid-content scan (14 days by default) -> `reports/merch-<date>.md`
- raw fetched data -> `feeds/<date>/`; the analysis layer only consumes the digest condensed by `digest.js`, to avoid a token explosion

## 5. Packaging

The shape actually adopted: **a single-file launcher + an `app/` directory**.

```
dist/VtuberMonitorLink/
  VtuberMonitorLink.exe     Node SEA single-file launcher (Node runtime embedded, about 90 MB)
  package.json              the launcher reads the version number
  README.txt                plain-ASCII quick start
  app/                      the program itself (server/ + web/dist/ + node_modules/)
```

### 5.1 Why the launcher is built as a SEA

- Use Node's built-in SEA (single executable application) to inject `launcher/launch.cjs`
  into a copy of `node.exe`, which yields a real single-file exe. The user does not need to install Node.
- **The entry point must be CommonJS**: on Node 24 the SEA's embedded `main` is still loaded
  as CJS, and ESM fails at runtime with `Cannot use import statement outside a module`.
  That is why the launcher is `.cjs`.
- **Inside a SEA, `process.execPath` is the launcher itself**, so it cannot re-spawn itself
  to run the program (that recurses forever). Two run modes:
  - `spawn`: when `runtime/node[.exe]` exists in the package, use it to start `app/server/src/index.js`;
  - `inline`: when the package has no `runtime/`, `import()` the program entry directly in its
    own process. The server is ordinary ESM on disk, so the standard ESM loader handles it
    without any problem - only the embedded `main` block is restricted. This saves a duplicate
    90 MB runtime copy and halves the release package.
- All path resolution is relative to the launcher itself (`--paths` prints the resolved results),
  with no hard-coded machine paths; `--doctor` runs automatically as the last packaging step,
  as the artifact's self-check gate.

### 5.2 Other optional shapes

| Option | Artifact | Notes |
| --- | --- | --- |
| single file + app/ (current) | `VtuberMonitorLink.exe` + `app/` | about 112 MB; no external dependencies, unzip and run |
| the same + bundled engine | plus `pw-browsers/` | `npm run build:portable`; no dependency on a system browser at all |
| with a separate runtime | plus `runtime/node.exe` | `--with-runtime`; the launcher switches to `spawn` mode |

### 5.3 Release verification

```bash
npm run verify        # proofread: required files / ASCII / UTF-8 / privacy and secret residue / runtime data
npm run traverse      # traversal: every HTTP endpoint, SPA fallback, error paths
npm run traverse:ui   # traversal: click through all six pages in a real browser + one real run with a mock LLM
npm run release       # all of the above
```

`npm run sanitize-check` adds one more: it scans the repository source for hard-coded paths and privacy residue.
The list of private names is **not hard-coded in the code** (otherwise the check script itself would become a leak source); it is read from
`$SANITIZE_NAMES` or from `.sanitize-names` in the repository root, which is already gitignored.

## 6. Network egress: why the proxy cannot be a global switch

Measured: both directions come apart:

- **without the proxy**: every site where direct connections are blocked (Reddit, Fandom ...) gives ECONNRESET / timeouts;
- **through the proxy**: Bilibili instead returns a steady 412 / -352 risk-control block.

So `net.js` offers three egress settings, and sources and watch targets can each override them:

| Value | Behaviour |
| --- | --- |
| (omitted) | follow the global `proxy.enabled` |
| `'proxy'` | force the proxy |
| `'direct'` | force a direct connection |

Plus one hard rule: **loopback addresses always connect directly**. Local Ollama (`127.0.0.1:11434`) and the
mock LLM used by traversal both live on this machine, so handing them to a proxy only fails.

## 7. Watch system / watch

Data model:

```
config.watch = { enabled, targets: [...], rules: {...} }
<app>/watch/history/<id>.baseline.json   one baseline per target
<app>/watch/history/<id>.jsonl           one history line appended per change
```

The baseline is "what it looked like last time", not "when it was last fetched" - the first check only
establishes the baseline and explicitly marks it `first: true`, never counting it as a change, so the very
first run does not flood the screen with false alerts.

`diff.js` is a hand-written line-level LCS diff: it first trims the common prefix and suffix to push the
DP size down, and degrades to whole-block replacement once over the limit; `diffHunks()` keeps only the
hunks that changed, with context lines, ready for the web page to render directly.

Alert decisions are centralised in `applyRules()`:

| Rule | Trigger condition |
| --- | --- |
| large edit / large deletion | byte delta exceeds the threshold |
| new page | MediaWiki `new` flag |
| anonymous edit | `anon` flag |
| unpatrolled edit | `unpatrolled` flag |
| log type | matches the configured logtype list |
| suspicious keyword | title/summary/body matches the word list |

Keyword matching for URL-type targets uses the added lines plus the first 1500 characters of the new
content; looking at added lines alone misses the case where a word is changed without adding a line.

## 8. Bilibili dynamics

See the "Bilibili dynamics" section of the README. The code is in `server/src/fetchers/bilibili.js`, with three paths in priority order:

1. **Logged-in state + JSON API** (preferred): extract cookies **read-only** from the configured profile
   (`cookies.js`), then call `feed/space`. The data is the cleanest - body text, attached images, publish
   time and like count are all there, and **the browser does not have to be closed**.
2. **Browser rendering**: when the logged-in state is unavailable, render `space.bilibili.com/<uid>/dynamic`
   with Playwright and scrape the DOM. It requires the target browser to be closed; when the profile is
   locked, Playwright's error is translated into plain language before being thrown.
3. **Login-free opus API**: used only by the `bili-opus` source; it returns body text and like count, with no attached images.

Measured points about `cookies.js`:

- the cookie database is at `<userData>/<Profile>/Network/Cookies` (older versions may lack the `Network` level);
- the key is in `os_crypt.encrypted_key` in `<userData>/Local State`: base64 -> strip the 5-byte
  `DPAPI` prefix -> DPAPI-decrypt to a 32-byte AES key;
- the value prefix `v10` = AES-256-GCM (nonce 12B / tag 16B); **the first 32 bytes of the plaintext are
  the domain-binding hash added by Chromium 130+, and must be stripped**;
- the prefix `v20`, or an `app_bound_encrypted_key` present in `Local State`, means App-Bound Encryption
  (the default since Chrome 127), which cannot be decrypted externally - this has to raise an explicit
  error rather than pretend to succeed;
- copy `-wal`/`-shm` along with the database, otherwise the SQLite view may be inconsistent;
- the original profile is **never modified** throughout, so this runs even with the browser open.

Parsing points for `feed/space` (all of them learned the hard way):

- `features=itemOpusStyle` is required. Without it, `major` on the newer image-and-text posts is
  `MAJOR_TYPE_DRAW` with an empty `items` and a null `desc` (the body text is lost entirely); with it,
  the type becomes `MAJOR_TYPE_OPUS`, the body sits in `major.opus.summary.text`, and **the number and
  URLs of the attached images are completely unchanged** (verified by comparison: body coverage
  3->11 / 0->7, and for 5 posts with 14 images both modes agree).
- the discriminating field is `major.type`, not `it.type`.
- the body of a repost lives in the reposted `it.orig` and has to be assembled as `//@原作者: …`
  (`//@` + the original author + `: …`).

## 9. LLM tiers

`llm.js` depends only on the OpenAI-compatible `/chat/completions` and `/models`:

- `PRESETS` is the preset catalogue; `newProvider()` derives one tier from a preset;
- `activeProvider(cfg)` returns the active tier and **downgrades the flat v1.0.0 shape (`llm.apiKey` etc.)
  to a single tier on the fly**, so old configs need no manual editing;
- `chatRequest()` assembles the request body in one place, and both `analyze.js` and `preflight()` go through it.

## 10. Intelligence items

`items.js` unifies the fetch results of every source into one structure:

```
{ id, kind, sourceId, sourceName, title, text, url, time, images[], stats{}, keywords[] }
```

The web card stream, the report's source list, keyword highlighting and follower growth all consume this
one structure, persisted at `<app>/feeds/<date>/_items.json`. That way the presentation layer no longer
has to understand the differences between fetch methods.

## 11. Localisation / i18n

Every string in the UI comes from the two source books in the source tree (`STRINGS.zh` / `STRINGS.en`
in `web/src/i18n.jsx`); every other locale inherits through a **fallback chain**
(`zh-TW -> zh-Hant -> zh-Hans`, `pt-BR -> pt-PT` ...), which never crosses languages and always lands on
English. Precedence: **machine translation -> hand-written generic keys -> the locale's own keys**
(hand-written always beats machine; `locales/overlays.js` is the hand-written layer, `locales/machine.json`
is the machine layer).

Toolchain (all of it runs offline, wired into `npm run verify:fast`):

| Tool | What question it answers |
| --- | --- |
| `tools/locale-coverage.mjs` | **is there a value** - coverage and the baseline ratchet (counting only the keys that locale itself provides) |
| `tools/i18n-proofread.mjs` | **is it usable** - compares displayed values against source strings one by one: placeholders, bold markers, newlines, leading/trailing spaces, residual sentinels (structural -> fails immediately), plus full-width punctuation, terms that did not take effect, cross-language length outliers (suspicious -> the tally must not grow) |
| `tools/i18n-translate.mjs` | **how to fill it in** - the machine-translation pipeline: term and placeholder-sentinel protection, a two-level cache keyed by source string + locale, the `--bust terms/suspicious/all` invalidation policy, and `--keys` for targeted retranslation |
| `tools/i18n-hant.mjs` | the three Traditional variants (OpenCC dictionaries, generated in full at build time, including Taiwan/Hong Kong wording) |
| `tools/i18n-plural-test.mjs` | **numeral forms** - checks the completeness of `locales/plurals.js` against `Intl.PluralRules` (every category a locale uses must have a form) |
| `tools/hint-md-test.mjs` | **markup rendering** - for keys whose value contains `**`/backticks/links, every call site must go through `<Inline>` |
| `tools/english-logic.mjs` | **engineering-layer language** - comments and output strings must not contain Chinese (except UI keys / API error strings / docs, see `docs/ENGLISH-LOGIC.md`) |

A few rules taught by real incidents (details in `docs/BUGS.md` 41-52, 54, 64-66):

- **A bad translation is worse than none**: if a filled-in translation still contains the source text, or
  a residual sentinel -> it is not written into the machine layer and the UI falls back to English (an
  untranslated English string at least offends nobody); if the old value is equally bad, drop it as well.
  The residual sentinel test must accept **any** `⟦…⟧` shape: the version that only recognised digits let
  `⟦n⟧` through all the way to Arabic users (BUGS #64).
- **An ambiguous source string is a bug in every language**: `天后` (days later) was taken as `歌后`
  (diva; Diva / Королева), so a component carrying a number has to be written as a whole sentence with a
  placeholder (`{n} 天后`, i.e. "{n} days later"), leaving the position to each locale.
- **Term protection cuts compounds in half**: `监测` (monitoring) splits `开播监测` (stream-start
  monitoring) down the middle, so the model translates `开播` (go live) as a verb.
  A compound has to enter the glossary as **one whole term**.
- **Numeral forms** (originally BUGS #54, fixed): `21 элементов` should be `21 элемент`. The approach is
  `tn(key, n)` (`web/src/plural.js`) + a `<key>_<类别>` form table (`web/src/locales/plurals.js`, the suffix being the plural category):
  locales whose values contain `{n}` write the number into the phrase, the rest keep it in front as before - **existing locales are unchanged word for word**,
  while ru/uk/pl/sr/ar and en/es/pt/fr/de/it get the correct singular/plural. zh/ja/ko do not inflect, so they need no form table.
  Filipino is the first locale that needs a table for a reason that is not inflection at all, so the rule is
  **three-tiered, not two**: `Intl.PluralRules('fil')` really does report two categories, but the split is by
  **last digit** (measured over 0..2000: `other` exactly when the number ends in 4, 6 or 9, `one` for everything
  else including 0 and 1) and the noun never changes - what Tagalog requires is the **linker** between a numeral
  and its noun (`5 na item`, never `5 item`). So the third tier is "needs a phrase for a reason the form count
  cannot express": a table whose two categories are spelled identically and whose base values stay bare nouns.
  A locale with one or two plural categories can still need a table, and a form count can overstate the cost
  (28 forms predicted for an inflection that does not exist) exactly as it understates it; `tools/i18n-plural-test.mjs`
  asserts the measured last-digit rule so this locale cannot be "simplified" back into the second tier.
  Thai (added one release later) is the same third tier reached from the other end: `Intl.PluralRules('th')`
  really does have a **single** category (`other` for all of 0..2000, decimals included), so the form count says
  "no table at all", while Thai counts with a numeral plus a **classifier** (`3 รายการ`, `2 วัน`, `5 ครั้ง`) and a
  numeral in front of a bare noun reads like a database field. The one form each key gets therefore carries the
  classifier inside the phrase, and the plural test pins the measurement so nobody can collapse it back into the
  bare-numeral tier. The general lesson: the decision is made by **measuring the rule and reading the language**,
  not by counting categories - a count can be right and still answer the wrong question.
  These two key classes are looked up dynamically and never appear in literal calls, so the counting rules
  for coverage / proofread are unaffected (`usedKeys()` and `locale-coverage` also recognise `tn(...)`).
- **A one-locale run must not edit other locales' machine layers**: `pruneMachine()` deletes entries the hand
  layer shadows, and the same shadowed rows exist in other locales, so adding one locale silently removed 22
  rows from eleven others. Those deletions are reverted and the new locale is spliced in. The dead rows are
  **kept on purpose**: they are invisible either way (the hand-layer repair overrides them), and if that repair
  is ever removed they are a better fallback than English. Re-running the pipeline will propose the deletion
  again - that is the decision to make then, for all eleven locales at once, not as a side effect.
- **Product copy and engineering output are two different things**: hard-coded strings in the daily report
  body, the push body and UI tooltips/toasts **stay Chinese** (even when they have no `t()` key);
  only logs, diagnostic files and self-check output switch to English.
  The boundary and the examples are in `docs/ENGLISH-LOGIC.md`.
- **Every UI string goes through a key**: this one was taught by "all 25 locales showed Chinese" - there
  used to be 30 hard-coded Chinese strings (`直播中` "live now", `来源 ↗` "source ↗", placeholders,
  `上次运行失败` "last run failed" ...) with no `t()` key, and a Chinese-language environment could never
  reveal them. Today the number of hard-coded Chinese strings in `.jsx` is **0**, and the pattern used by
  `browserFromSettings`, where the server returns only a marker and the UI supplies the wording, is the
  standard approach (Chinese returned by the server would be displayed verbatim in every locale).

## 12. Observe mode / observation mode

To judge the real state of an agency you have to look at several of its members at the same time; but
sweeping a whole agency at one instant is itself a trace, and that is **independent of which IP you come
from**. So the trade-off in this area is: **Tor only solves "who is looking"; sampling and jitter are what
solve "what is being looked at, and when"**. The full threat model, the measured data (Bilibili is about
8x slower through Tor, the agency's self-hosted site anycolor returns Cloudflare 403, the measured IPs of
rotated exits) and the configuration notes are all in `docs/OBSERVE.md`; the pure logic is in
`server/src/observe.js`, with the self-check in `tools/observe-test.mjs` (a fixed random source pins the behaviour).

The one-line version:

- **Sampling**: each round takes a random subset (50% by default). Candidates are ordered by "longest
  since last looked at", then drawn at random from that pool, and the order is shuffled after drawing.
  Pure random catches up too slowly, while pure LRU becomes predictable. The local incremental archive
  keeps the picture complete over several days.
- **Jitter**: random intervals (3-12 seconds by default); no jitter when `base = 0` (an explicit "do not wait" wins).
- **Egress split by log attribution**: only agency self-hosted sites (the `AGENCY_HOSTS` allowlist) go
  through Tor; platform sources are left alone - the agency cannot see those logs, while Tor is slower and
  rate-limits some endpoints.
- **No identity is sent**: sources that need a logged-in state do not run in this mode (a far stronger link than an IP).
- **Exit rotation**: separate exits come from isolating by Tor's SOCKS username, so different sources land
  on different exits; one source keeps a single circuit within one round.
- **Honest display**: both the run page and the report state that this round is a sample, and stress that
  not appearing in this round does not mean nothing happened.

## 13. Looking at a whole agency

"What is new today" and "how is this agency doing right now" are two different questions, and a per-item
intelligence stream only answers the first. Four blocks address the second (all pure logic + offline self-check):

| Module | What it answers | Self-check |
| --- | --- | --- |
| `silence.js` | who stopped, for how long, and whether the whole agency stopped together (the criterion is relative to **each member's own rhythm**, not a fixed number of days) | `silence-test.mjs` 16 checks |
| `groups.js` | activity heat map by agency, co-occurrence (the shape of a collaboration across the unit), shared silence, individual anomalies; `/api/groups` + the agency-view block on the following page | `groups-test.mjs` 11 checks |
| `dormant.js` | people inactive for >=6 months: the daily report lists their latest content **last**, as one block; those who moved again recently are flagged separately as `可能复出` (possibly returning) | `dormant-test.mjs` 10 checks |
| `fetchplan.js` | fetch scheduling: parallel groups by egress (serial inside a group), isolation of consecutive failures, a degradation ladder for fetch methods | `fetchplan-test.mjs` 15 checks |

Two pitfalls we hit are worth keeping in code comments: the baseline window **must not be anchored on the
last active day** (someone who posts monthly would be treated as a daily poster, the tolerance window
collapses to 3 days, and a 5-day gap then raises a false alert); and "returning" **must not look only at
the last active day** (for someone returning, that day is today, which looks perfectly healthy - what
matters is how long they were quiet before that).

On cost: `cost.js` records per run (`logs/cost.jsonl`), `/api/cost` aggregates it, and the LLM page has a
dashboard; the budget only warns by default, and only `llm.budget.onExceed = 'stop'` actually blocks.
Calls whose usage is unavailable are counted separately, without guessing numbers.

## 14. Roster (VDB)

The dimension that both the agency view and per-person following lack is the **circle**: entering 30 people
by hand means doing it 30 times, and "this person's accounts on other platforms" cannot be assembled from
scraped news either. So the project consumes a public roster, `dd-center/vdb` (the upstream of vtbs.moe),
**one file per person**: multilingual names + `accounts` (platform -> id) + `group`.

Three design trade-offs:

1. **One request fetches the whole database**, with no incremental updates and no per-record API calls.
   The full tarball is 0.54 MB / 10035 records / 215 circles, and one `codeload` request takes a second or
   two; calling the GitHub API record by record would take thousands of requests, burn through quota and
   produce noisy logs. The roster changes very slowly, so the TTL is 7 days.
2. **Platform independence is a hard requirement**, not "supporting platforms beyond Bilibili as a bonus".
   Whatever platform appears in `accounts` is accepted (`PLATFORM_URLS` has 27: bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico /
   showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon /
   line / github ...). Alias generation, search and import all follow the generic "platform -> id" shape,
   and there is no `if (platform === 'bilibili')` branch anywhere in the code. A search matches the id or
   the link form of **any platform**.
3. **The licence is part of the data**. The VDB data is **CC BY-NC-SA 4.0** and its code is GPL, while
   this project is MIT: so it is **fetched at runtime only**, cached in `app/vdb/`, and **never enters the
   repository or the release package** (`.gitignore` + the `make-zip` exclusion list + the
   `verify-release` runtime-state list all guard it), and the UI and the docs both credit the source.

Import is not a back door: a selected record is first converted into the standard follow-target shape and
then passed through **the same** `sanitizePerson()` as manual entry (which is where id conflicts, aliases
and link validity are rejected), and anything rejected reports its reason one by one.

Two rules in the upstream standard **collide with** rules we designed independently: its deletion condition
is "the history information is removed ... and **6 months with no activity**", which matches our 6-month
"inactive" criterion; its circle-inclusion requirement asks for at least **2 members** as corroboration,
while our agency-level signal needs at least **3 members** before drawing a conclusion - the same kind of
caution, which counts as one cross-validation. Only 17.6% have a circle (1770/10035); that is reality
rather than a data defect, so the UI does not treat "no circle" as an anomaly.

Details (data shape, licence boundary, API, self-check, what was left undone) are in `docs/VDB.md`; the
pure logic is in `server/src/vdb.js` and `server/src/tar.js` (zero-dependency tar reading), with the
self-check in `tools/vdb-test.mjs`, 25 checks.

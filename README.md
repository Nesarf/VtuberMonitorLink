# Vtuber's Monitor Link

> **A local-web VTuber intelligence monitor** — pick your own browser, your own sources, and the exact pages you want watched.
> Everything runs on your machine: one executable, a local web UI, no account, no service in the middle.

**English** · [简体中文](README.zh-CN.md)

> The same document is available **inside the app**: the `About` button in the top right opens it and switches language instantly (no reload, no navigation).

---

## What it does

Runs a small local service (`http://127.0.0.1:43110` by default) with a web UI. Once configured, it will:

1. **Scrape the sources you tick** — 23 built-in sources (Reddit / Fandom / Moegirlpedia / Twitch / YouTube / official news pages / merch platforms …), four fetch kinds
2. **Check the watch targets you pin** — any web page, a wiki page, a wiki recent-changes stream, your own wiki watchlist — and report exactly what changed
3. **Group intel by person, not by source**: fill in names and accounts and the app attributes items locally (plain string matching, no network, no LLM), showing exactly which alias hit which field
4. **Merge the same event across sources**: similarity dedupe + source weight (official > news > community > social), with a "confirmed by N sources" marker
5. **Analyse everything with an LLM** (optional) into a structured report; images can be tagged by a vision model and become searchable labels
6. **Show it all in the console**: intel cards, rendered reports, **trend charts**, **anniversary countdowns**, full-text search, **one-click single-file share**, Word/Excel export

## The eleven pages

| Page | What it does |
| --- | --- |
| **Intel** | Every item from the latest run as a card; merge-duplicates view; picture tags, person hits and keyword alerts are flagged |
| **Search** | Pure local matching (keyword / tag / time) — no LLM, no network |
| **People** | The follow list — names, aliases, accounts; per-person feed and export; match evidence on demand; **import from the VDB roster** (brings group and per-platform accounts along) |
| **Calendar** | Birthday / debut / 3D reveal / anniversary countdowns + a month grid; leap days and regional time zones handled |
| **Run** | Collect now (regular / merch / watch-targets-only) with live progress and log |
| **Sources** | Tick any of 23 built-in adapters; per-source egress, latency/loss, self-test; add your own visually |
| **Watch** | Watch targets, alarm rules, change history and diffs |
| **Browser** | The one page that owns the browser and its profile: mode, profile discovery, anonymous mode, and a per-feature table saying what each dependent feature needs and whether it has it; **Check login** reads a host's cookie store read-only |
| **LLM** | Profiles (multi-provider / model / key, masked, one-click test, model list); which features need it |
| **Settings** | Browser, egress (direct / proxy / Tor, auto-matched per site), schedule, notifications, privacy, interface |
| **Reports** | Trend charts + one-click share + report list: rendered / raw, search, export, two-version comparison |

## The nine capabilities (all with self-tests)

| Capability | Highlights |
| --- | --- |
| **Anniversary countdowns** | 2/29 rolls to 3/1 in common years **and says so**; "today" follows your configured time zone; week start follows the region |
| **Push channels & quiet hours** | 12 channels (Bark / ServerChan / Telegram / **DingTalk signed** / WeCom / ntfy / Gotify / PushPlus / Slack / Discord / Feishu / custom); notifications inside quiet hours are **queued and re-sent, not dropped**, midnight crossing handled, bad config fails open |
| **Follow by person** | CJK substring matching + Latin word-boundary matching (so `Rei` does not hit `Reimu`); every hit carries evidence |
| **Image tagging** | 8 kinds + visible text; cached per image URL; **off by default** — sending images to an external service requires you to turn it on |
| **Event merge & source weight** | IDF-weighted similarity + union-find single link + time window; weights grow from "who reported it first" |
| **SQLite archive & charts** | Idempotent incremental writes keyed by item id; daily counts; charts are **inline SVG**, no chart library |
| **One-click share** | A single HTML file with zero external references (readable offline), plus copy-as-text / Markdown / JSON / webhook. Each posting site is described as **three stages kept apart** (account / verification / send) with its login requirement stated honestly; a site this build has no publishing code for says *that*, and hands the composed body to the site's own compose page as a recorded manual action |
| **Locales & regions** | 29 locales (zh-Hant/HK/TW, en-US/GB/AU/CA, es-ES/419/MX/AR, pt-PT/BR, fr-FR/CA, de/it/ja/ko/ru/uk/pl/sr/ar, id-ID, fil-PH, th-TH, vi-VN); RTL; dates, numbers and week start formatted per region; **plural forms** chosen by `Intl.PluralRules` (`1 запись / 2 записи / 5 записей`, which also fixes the old English `1 items`); per-entry proofreading, a coverage ratchet and a markup-rendering guard all run inside `verify:fast` |
| **Automatic egress** | Each site picks direct or proxy by "effective latency = mean latency × (1 + loss × 4)", with stickiness (no switch below a 20% edge); real fetch results feed the decision back |

## VDB roster (multi-platform)

The dimension "follow by person" and "group view" were missing is **the agency**. Filling in 30 people by hand means 30 forms, so this connects to a public roster: `github.com/dd-center/vdb` (the upstream database behind vtbs.moe), **one file per person** — multilingual names + per-platform accounts + group.

- **The whole database in one request**: the tarball is only **0.54 MB / 10035 records / 215 groups**; one request, a second or two, instead of thousands of API calls
- **Platform-agnostic**: 27 platforms (bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico / showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon / line / github …). Searching **any** platform's account id or URL form works, and nothing in the code special-cases a platform
- **Those account fields are data about people, not a connection to those sites**: a person's `bilibili` or `twitter` id is a field name in their record, matched locally against text the app already collected. It is never fetched, queried or posted to — the platform set here is the roster's vocabulary, not this build's network
- **Import takes the same sanitising path**: selection → person shape → the same validation as manual entry; anything rejected is reported per row with a reason, never silently dropped
- **Licensed CC BY-NC-SA 4.0**: so it is **fetched at runtime only**, cached in a runtime directory, and **never committed or bundled** (the release checks stop it), with attribution in both the UI and the docs
- Details: `docs/VDB.md`

## Group view, silence & dormant, observation mode, usage & budget

"Nothing happened" is intelligence too. These four blocks deal with **silence, absence and cost**:

| Capability | Highlights |
| --- | --- |
| **Group view** | Per-agency activity heatmap, same-day activity (what a project or collab looks like), joint silence, and per-person anomalies relative to **each person's own cadence**. Only followed people with an Agency filled in are counted (importing from VDB fills it for you) |
| **Silence & dormant** | The baseline is the **average spacing between recent active days** — not a window anchored on the last active day, which makes a once-a-month poster look daily. Tolerance is `gap × 2.5`, clamped to 3–90 days. **Comeback** requires recent activity *and* a long prior gap, so returnees are recognised and quiet accounts are not false-alarmed. Entities idle for 6+ months are collected in a "stopped activity / graduated" block at the very **end** of the daily report with their latest content, and a sudden stir is flagged |
| **Observation mode** | "Someone swept the whole roster" is itself a signal. Each round samples a **random subset** (ranked by least-recently-picked, so rotation fills coverage in), gaps are jittered, Tor is used **only for sites whose logs the other side owns**, and sources that need a login are skipped for that round. Trade-offs and measurements: `docs/OBSERVE.md` |
| **Usage & budget** | Token usage per run and per model; an optional daily budget warns at 80% and can block a whole run; when a model does not report usage those calls are **counted separately instead of guessed** |


## Watch targets (borrowed from Moegirlpedia's watch technology)

MediaWiki's `watchlist-brief` / `recent-changes-brief` idea is: **don't just say "it changed" — say what changed, by how much, and whether it deserves attention.** That is what this does, across four target kinds:

| Kind | What it reads | Login |
| --- | --- | --- |
| **Any web page** | Fetch → normalise → hash baseline → line diff (ignorable lines configurable) | no |
| **MediaWiki page** | `revid` comparison + `action=compare` diff, with byte delta | no |
| **MediaWiki recent changes** | The recent-changes stream, filtered down to what matters | no |
| **MediaWiki watchlist** | Your own watchlist (BotPassword login) | **yes** |

Alarm rules (all thresholds editable): large edit / large delete / new page / anonymous edit / unpatrolled edit / chosen log types / **suspicious keywords** (graduation, contract termination, retirement, scandal, hiatus, dissolution, transfer …).

The first check only **builds a baseline** — it never cries wolf. Later checks say who changed what, by how much, and which lines.

## What this build deliberately does not do

No part of the product has a network relationship with bilibili or X/Twitter any more. Removing it took the
six built-in sources that read them, the `bili-opus` / `bili-dynamic` fetch kinds, three source categories
(`live` / `bili` / `social`), the `bili-opus` watch-target kind, the whole **Live** tab (live-state checks, the
embedded player and danmaku sending), the account-discovery and send-verification routes that served the
removed features, and `docs/LIVE.md`. What was **kept on purpose** is everything that was never actually
about those sites:

- **The read-only cookie probe is generic.** It copies a browser's own store and reads it read-only for **a host the caller names**, reporting cookie *names* and never values. Only the per-site uses that belonged to those platforms went; the mechanism and the page that owns the setting all stay — though the browser it reads is now Firefox (see below), so the Chromium decryption notes that used to be here are gone with the code.
- **The posting table is still three stages.** Account / verification / send are answered separately per site, because collapsing them hides which step is missing. No posting site in this build declares publish code, so the send stage says exactly that — and `/api/share/post` still refuses every call for that stated reason, behind its explicit-confirm and audit gate. That gate is the discipline, not a platform feature.
- **The manual hand-off stays.** Where this app cannot post, it hands the composed body and images to the site's own compose page and records the click as a **manual** action.
- **The roster's per-platform accounts stay** (see the VDB section above): they are data about people.
- **Egress and monitoring are untouched**: per-source direct / proxy / Tor with per-site overrides, the latency/loss probe, "effective latency = mean × (1 + loss × 4)", observation-mode sampling and jitter, and the run archive all still apply to the sources that remain.

## Getting a login without closing your browser

Some sources need a login (the Twitch following list, a wiki watchlist, or a source you declare yourself).
The old answer was "close the browser, then let Playwright reuse the profile" — a steep price for one Cookie
header. So there is a lighter path:

**Copy the browser's cookie store and read it read-only.** The browser can stay open; nothing is
locked or modified.

- The **Browser** tab → *Check login*, with the host to read (the field starts at `reddit.com`; name any
  host). That tab is also where the browser and its profile are configured, and where each dependent
  feature reports what it needs and whether it has it.
- The probe is **generic on purpose**: it knows nothing about any particular site, reads only the host the
  caller named, and never holds a per-site list of what a login looks like.
- Measured: Firefox keeps its cookies in `cookies.sqlite` (table `moz_cookies`) and the value is
  **plaintext**. There is no key to find, so there is no decryption step that can fail — either the
  cookie is read, or that profile simply has none for the domain. `host` is what Chromium called
  `host_key`, leading dot included, which is how a domain cookie outranks a host-only row of the same name.
- A directory that is **not** a Firefox profile answers as its own state (`no-firefox-profile`) rather
  than as "not signed in" — a Chromium profile is not a store this reader can open, and saying so is
  more useful than reporting an empty result.
- The login is used only to call that site's own API. **Cookie values never reach a log, a report
  or `feeds/`**, the copied store is deleted immediately, and the HTTP endpoint only ever reports
  cookie *names*, never values.

## The browser engine is Firefox

The bundled browser is **Playwright's Firefox** (155.0, build `firefox-1543`); Chromium is gone from the
code, the flags, the hard-coded user agent and the packaged payload. What that means in practice:

- **Only a Playwright Firefox build can be driven.** Playwright speaks the Juggler protocol, which a stock
  `firefox.exe` does not implement, so a stock install is refused up front with the reason instead of
  failing three seconds later as "Failed to launch the browser process". The fix is named in the message:
  `npx playwright install firefox`. That means the `system` / `custom` modes offer Playwright engines only,
  and the old advice — "point it at the Chrome you already have" — no longer holds.
- **Every browser this app launches uses that engine** — a `fetch: browser` render, a screenshot thumbnail,
  and the UI traversal. The egress is shared too (`resolveBrowserEgress` in `server/src/net.js`), the same
  door every other fetch uses: the Tor SOCKS port is probed **before** a browser starts, so "Tor is not
  running" is a clear reason and no browser is launched. Screenshots moved onto that same egress — they used
  to go **direct** during Tor mode, which meant a privacy setting that quietly took a picture from this
  machine's own address.
- **A measured engine limit, stated rather than hidden**: Playwright's Firefox cannot authenticate to
  SOCKS5 (it offers only the no-auth method and ignores Firefox's own `socks_username` prefs). Browser
  traffic through Tor therefore rides the **default circuit**; the per-subject `IsolateSOCKSAuth` exit
  rotation still applies to every non-browser fetch.
- **Measured payload**: the `--with-browsers` payload went from 705.6 MB (Chromium) to **345.3 MB**
  (Firefox); the `--with-browsers` zip is 169.5 MB, and the zip without browsers is unchanged at 40.4 MB.
- **Profile discovery reads Firefox, not a fixed layout.** A Firefox profile is named by the `profiles.ini`
  in its install root rather than living in a `Default` / `Profile 1` subdirectory, and a profile belongs to
  **the machine rather than to one executable** — so the bundled engine can reuse the Firefox login you
  already have, and the default profile is offered in every mode. It is only **offered** (a one-click "use
  this one"), never substituted for an empty setting. Three pre-existing defects were fixed with this: the
  documented default answered empty in the running app, `present` was always false, and a real Firefox
  *root* (which carries zero-byte `cookies.sqlite` / `places.sqlite` from an older layout) could pass as a
  profile, so the profiles inside it were never offered.

## LLM

- Nine built-in presets: DeepSeek / OpenAI / Moonshot·Kimi / Zhipu GLM / Alibaba Qwen / SiliconFlow / OpenRouter / **local Ollama** / custom.
- **Keep several profiles and switch between them** — add, edit and delete them in the UI.
- "Fetch models" hits `/models`; "Test connection" pings `/chat/completions`.
- The key lives only in the local `app/config.json`; the API returns a masked `***` and only reveals it in the input when you ask.
- **Loopback addresses are always direct**, so a local Ollama never gets swallowed by the proxy.

## Locales & the translation pipeline

The UI ships **29 locales** (`zh-Hans/Hant/HK/TW`, `en-US/GB/AU/CA`, `es-ES/419/MX/AR`, `pt-PT/BR`, `fr-FR/CA`, `de/it/ja/ko/ru/uk/pl/sr/ar`, `id-ID`, `fil-PH`, `th-TH`, `vi-VN`). Arabic is RTL, and dates, numbers, the first day of the week and plural forms all follow the region.

**Fallback rule**: regional differences are inherited **within one language only** (`es-MX → es-419 → es-ES`, `zh-TW → zh-Hant → zh-Hans`), and anything missing falls back to **English**, never to a different language. That rule was written after a real incident: the `uk/pl/sr` chains once pointed at Russian, so Ukrainian users were shown Russian. That is not "imperfect translation", it is simply wrong.

**Entry priority** (later overrides earlier):

```
machine translation (optional, lowest)  →  hand-written  →  build-time generated (Traditional, OpenCC)  →  English fallback
```

Machine translation is **its own layer and never beats a hand-written entry**, so a bulk pass can't overwrite anything reviewed, and it stays obvious which strings still need a second pair of eyes.

**The pipeline** (`tools/i18n-translate.mjs`):

| Mechanism | Why it is needed |
| --- | --- |
| **Pluggable engines** | `mock` (a local fake engine, free, used to exercise the pipeline) today, any OpenAI-compatible endpoint tomorrow; swapping engines doesn't touch the pipeline. With no url/key it **refuses to run** rather than calling out with an empty key |
| **Cache keyed by source string + target language** | the same sentence is never paid for twice; editing the source naturally makes a new key. The cache holds no credentials |
| **Glossary** (`glossary.json`) | names and product words must stay fixed — they are replaced with sentinels before translating, so the model never gets a chance to change them |
| **Placeholder protection** | `{target}`, `${x}`, `%s`, newlines and `MM-DD` all become sentinels, and the result is checked for **complete restoration**; a missing one drops the entry (missing beats broken) |
| **Incremental, and one failure doesn't sink the batch** | only missing keys are translated; failures are recorded and retried next time; `--limit` caps a run |

```bash
npm run i18n:coverage                     # how much each locale actually covers (English fallback doesn't count)
npm run i18n:translate -- --missing ja-JP # list the keys a locale still lacks
npm run i18n:translate -- --engine openai --url <endpoint> --key <key> --locales ja-JP,ko-KR
npm run i18n:review -- ja-JP              # list machine translations for a human pass
npm run i18n:coverage:update              # raise the baseline (the ratchet only goes up)
```

Coverage is **measured and pinned as a lower bound**: `verify:fast` compares against `web/src/locales/coverage.json` and fails when it drops, so "added a feature, forgot the strings" cannot happen quietly. `npm run english` prints the other half of the picture — how much of the engineering layer is English.

## Two ways to run

**1. Use the release build** — download `VtuberMonitorLink-1.0.0-win-x64.zip` from the Releases page, unpack anywhere, double-click `VtuberMonitorLink.exe`. No Node install, no admin rights, no terminal.

> Naming: **user-facing files keep the full name** (exe / zip / the unpacked folder), **internal identifiers use the short brand `VML`** (npm package names, `VML_*` environment variables, `vml-*` storage keys, temp files). `npm run brand` enforces the split.

**2. Run from source** — `npm install`, then `npm run dev` (server 43110 + frontend 43111) or `npm run build && npm start`.

## Want to try it without spending tokens?

The repo ships a local mock LLM (OpenAI-compatible, zero dependencies):

```bash
npm run mock-llm         # listens on 127.0.0.1:43197
```

Add a custom profile in Settings → LLM with base URL `http://127.0.0.1:43197`, any key, model `mock-model`, and the whole pipeline (scrape → watch → intel → analyse → report) runs end to end at no cost.

## Privacy

- **No account or cookie is ever bundled or uploaded.** Any site that needs a login is logged into by you, in your own browser.
- The LLM key and the optional Moegirlpedia BotPassword live only in the local `app/config.json` — never committed, never shipped.
- `config.json`, `reports/`, `feeds/`, `logs/`, `watch/`, `thumbs/`, `advice/`, `vdb/` are never committed (see `.gitignore`).
- Run `npm run sanitize-check` before publishing.

## Third-party data & attribution

The code here is MIT, but the tool **fetches data at runtime** that has its own licence and authors:

| Source | Used for | Licence / attribution |
| --- | --- | --- |
| **[dd-center/vdb](https://github.com/dd-center/vdb)** | The agency roster (`docs/VDB.md`) | Data **CC BY-NC-SA 4.0**, code GPL. **Fetched at runtime, never bundled, never redistributed**, attributed in the UI and docs |
| Moegirlpedia's `watchlist-brief` / `recent-changes-brief` | Design reference for watch targets | Idea only, no code copied |

Scraped items belong to their own publishers. This tool aggregates them locally and **republishes nothing**.

## Release checks

```bash
npm run verify        # proofread the release: required files / ASCII / UTF-8 / leaked keys & paths / run data
npm run traverse      # walk every HTTP endpoint, the SPA fallback and the error paths
npm run traverse:ui   # walk all eleven pages in a real browser and do a real run against the mock LLM
npm run brand         # naming: user-facing files keep the full name, internal identifiers use VML
npm run english       # English coverage, for both the engineering layer and the UI
npm run commit-msg    # every commit message in the history is English
npm run release       # all of the above
```

Four convention guards ride along in the same chain (`verify:fast`):
`tools/english-logic.mjs` (the engineering layer is English only — comments and logs; UI strings and
product copy are out of scope, see `docs/ENGLISH-LOGIC.md`; `npm run english` prints the coverage),
`tools/vml-brand.mjs` (the two names must not swap roles), `tools/i18n-plural-test.mjs`
(plural-form tables are complete per language) and `tools/hint-md-test.mjs`
(any string carrying markdown must be rendered through `<Inline>`).

Commit messages are English as well, on every branch and tag: the history is the part of a project
a reader anywhere sees first, and a body only some readers can follow cannot be searched, quoted or
reviewed. `npm run commit-msg` checks the whole history (`tools/commit-msg-check.mjs`, the rule is in
`tools/lib/cjk-text.mjs`); `.githooks/commit-msg` blocks a Chinese message at commit time
(`git config core.hooksPath .githooks`), and CI checks it with a full-history checkout, because a
shallow clone can only judge its tip. Quoting another language as evidence — a Russian plural form,
an Arabic date phrase — stays allowed: that is data about a translation, not Chinese prose.

## License

MIT

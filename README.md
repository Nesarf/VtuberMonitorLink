# Vtuber's Monitor Link

> **A local-web VTuber intelligence monitor** — pick your own browser, your own sources, and the exact pages you want watched.
> Everything runs on your machine: one executable, a local web UI, no account, no service in the middle.

**English** · [简体中文](README.zh-CN.md)

> The same document is available **inside the app**: the `About` button in the top right opens it and switches language instantly (no reload, no navigation).

---

## What it does

Runs a small local service (`http://127.0.0.1:43110` by default) with a web UI. Once configured, it will:

1. **Scrape the sources you tick** (Reddit / Fandom / Moegirlpedia / Twitch / X / YouTube / official news pages / **bilibili dynamics** / merch platforms …)
2. **Check the watch targets you pin** — one wiki page, one arbitrary URL, one bilibili UP — and report exactly what changed
3. **Group intel by person, not by source**: fill in names and accounts and the app attributes items locally (plain string matching, no network, no LLM), showing exactly which alias hit which field
4. **Merge the same event across sources**: similarity dedupe + source weight (official > news > community > social), with a "confirmed by N sources" marker
5. **Analyse everything with an LLM** (optional) into a structured report; images can be tagged by a vision model and become searchable labels
6. **Show it all in the console**: intel cards, rendered reports, **trend charts**, **anniversary countdowns**, full-text search, **one-click single-file share**, Word/Excel export

## The eleven pages

| Page | What it does |
| --- | --- |
| **Intel** | Every item from the latest run as a card; merge-duplicates view; picture tags, person hits and keyword alerts are flagged |
| **Search** | Pure local matching (keyword / tag / time) — no LLM, no network |
| **Live** | Live status (live / rerun / offline) + multi-screen; you can send a danmaku from the channel (login required, manual confirmation) |
| **People** | The follow list — names, aliases, accounts; per-person feed and export; match evidence on demand; **import from the VDB roster** (brings group and per-platform accounts along) |
| **Calendar** | Birthday / debut / 3D reveal / anniversary countdowns + a month grid; leap days and regional time zones handled |
| **Run** | Collect now (regular / merch / watch-targets-only) with live progress and log |
| **Sources** | Tick any of 30 built-in adapters; per-source egress, latency/loss, self-test; add your own visually |
| **Watch** | Watch targets, alarm rules, change history and diffs |
| **LLM** | Profiles (multi-provider / model / key, masked, one-click test, model list); which features need it |
| **Settings** | Browser, egress (direct / proxy / Tor, auto-matched per site), schedule, notifications, privacy, interface |
| **Reports** | Trend charts + one-click share + report list: rendered / raw, search, export, two-version comparison |

## The ten capabilities (all with self-tests)

| Capability | Highlights |
| --- | --- |
| **Anniversary countdowns** | 2/29 rolls to 3/1 in common years **and says so**; "today" follows your configured time zone; week start follows the region |
| **Danmaku sending** | **WBI signing** (nav → key → 64-slot permutation → `w_rid`); six gates: explicit confirmation, named account, cookie re-read on the spot, local rate limit, audit trail, never automated |
| **Push channels & quiet hours** | 12 channels (Bark / ServerChan / Telegram / **DingTalk signed** / WeCom / ntfy / Gotify / PushPlus / Slack / Discord / Feishu / custom); notifications inside quiet hours are **queued and re-sent, not dropped**, midnight crossing handled, bad config fails open |
| **Follow by person** | CJK substring matching + Latin word-boundary matching (so `Rei` does not hit `Reimu`); every hit carries evidence |
| **Image tagging** | 8 kinds + visible text; cached per image URL; **off by default** — sending images to an external service requires you to turn it on |
| **Event merge & source weight** | IDF-weighted similarity + union-find single link + time window; weights grow from "who reported it first" |
| **SQLite archive & charts** | Idempotent incremental writes keyed by item id; daily counts; charts are **inline SVG**, no chart library |
| **One-click share** | A single HTML file with zero external references (readable offline); **login requirements stated honestly per platform**, unsupported ones are labelled as such |
| **Locales & regions** | 25 locales (zh-Hant/HK/TW, en-US/GB/AU/CA, es-ES/419/MX/AR, pt-PT/BR, fr-FR/CA, de/it/ja/ko/ru/uk/pl/sr/ar); RTL; dates, numbers and week start formatted per region; **plural forms** chosen by `Intl.PluralRules` (`1 запись / 2 записи / 5 записей`, which also fixes the old English `1 items`); per-entry proofreading, a coverage ratchet and a markup-rendering guard all run inside `verify:fast` |
| **Automatic egress** | Each site picks direct or proxy by "effective latency = mean latency × (1 + loss × 4)", with stickiness (no switch below a 20% edge); real fetch results feed the decision back |

## VDB roster (multi-platform)

The dimension "follow by person" and "group view" were missing is **the agency**. Filling in 30 people by hand means 30 forms, so this connects to a public roster: `github.com/dd-center/vdb` (the upstream database behind vtbs.moe), **one file per person** — multilingual names + per-platform accounts + group.

- **The whole database in one request**: the tarball is only **0.54 MB / 10035 records / 215 groups**; one request, a second or two, instead of thousands of API calls
- **Platform-agnostic**: 27 platforms (bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico / showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon / line / github …). Searching **any** platform's account id or URL form works; nothing in the code assumes bilibili
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

MediaWiki's `watchlist-brief` / `recent-changes-brief` idea is: **don't just say "it changed" — say what changed, by how much, and whether it deserves attention.** That is what this does, across five target kinds:

| Kind | What it reads | Login |
| --- | --- | --- |
| **Any web page** | Fetch → normalise → hash baseline → line diff (ignorable lines configurable) | no |
| **MediaWiki page** | `revid` comparison + `action=compare` diff, with byte delta | no |
| **MediaWiki recent changes** | The recent-changes stream, filtered down to what matters | no |
| **MediaWiki watchlist** | Your own watchlist (BotPassword login) | **yes** |
| **bilibili dynamics** | New `opus_id`s plus follower growth | no |

Alarm rules (all thresholds editable): large edit / large delete / new page / anonymous edit / unpatrolled edit / chosen log types / **suspicious keywords** (graduation, contract termination, retirement, scandal, hiatus, dissolution, transfer …).

The first check only **builds a baseline** — it never cries wolf. Later checks say who changed what, by how much, and which lines.

## bilibili dynamics

What the measurements forced:

- `api.bilibili.com` works **direct**, and going through a proxy gets you a steady 412 / -352 risk-control block. So bilibili sources default to the *direct* egress; the proxy setting is global, but sources and watch targets can each override it.
- A bare request is blocked with 412 until you fetch `buvid3/buvid4` from `x/frontend/finger/spi` and send them as cookies.
- `x/polymer/web-dynamic/v1/opus/feed/space` needs **no login and no wbi signature** and reliably returns text/image dynamics (text, likes, opus link) — that is the main path.
- `x/polymer/web-dynamic/v1/feed/space` (full dynamics *with* pictures) is heavily rate/risk-controlled and only works with **a reused login** → that source is marked login-required and rendered in a browser.
- `x/relation/stat` provides the follower count used for growth tracking.

## Getting a login without closing your browser

Some sources need a login (bilibili dynamics with pictures, X post bodies). The old answer was
"close the browser, then let Playwright reuse the profile" — a steep price for one Cookie header.
So there is a lighter path:

**Copy the browser's cookie store and decrypt it read-only.** The browser can stay open; nothing is
locked or modified.

- Settings → Browser → *Check login*, with the domain to read (defaults to `bilibili.com`).
- Measured: on Opera / Chromium 130+ the `v10` scheme (AES-256-GCM, key protected by DPAPI) reads
  fine, including stripping the 32-byte domain-binding prefix Chromium 130+ prepends.
- **Chrome 127+ enables App-Bound Encryption by default** (`v20`), which cannot be decrypted from
  outside. The tool says so explicitly and points you back at the close-the-browser route instead
  of failing silently.
- The login is used only to call that site's own API. **Cookie values never reach a log, a report
  or `feeds/`**, the copied store is deleted immediately, and the HTTP endpoint only ever reports
  cookie *names*, never values.

## LLM

- Nine built-in presets: DeepSeek / OpenAI / Moonshot·Kimi / Zhipu GLM / Alibaba Qwen / SiliconFlow / OpenRouter / **local Ollama** / custom.
- **Keep several profiles and switch between them** — add, edit and delete them in the UI.
- "Fetch models" hits `/models`; "Test connection" pings `/chat/completions`.
- The key lives only in the local `app/config.json`; the API returns a masked `***` and only reveals it in the input when you ask.
- **Loopback addresses are always direct**, so a local Ollama never gets swallowed by the proxy.

## Locales & the translation pipeline

The UI ships **25 locales** (`zh-Hans/Hant/HK/TW`, `en-US/GB/AU/CA`, `es-ES/419/MX/AR`, `pt-PT/BR`, `fr-FR/CA`, `de/it/ja/ko/ru/uk/pl/sr/ar`). Arabic is RTL, and dates, numbers, the first day of the week and plural forms all follow the region.

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
| **[api.vtbs.moe](https://vtbs.moe)** | Roster lookups for the live page | Upstream service; queried only, never cached and redistributed |
| **[dd-center/bilibili-dd-monitor](https://github.com/dd-center/bilibili-dd-monitor)** | The *idea* behind multi-screen live viewing | MIT (Copyright (c) 2020 wdpm); rewritten here, not copied (see `docs/LIVE.md`) |
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

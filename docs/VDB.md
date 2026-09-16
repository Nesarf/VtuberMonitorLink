# VDB roster / VDB 花名册

> This page explains how the agency (circle) roster capability is wired in, why it is wired that way, and where its boundaries are.
> It is not a tenth item next to the nine capabilities; it **supplies the missing dimension** for "follow by person" and "agency view": the agency.

---

## 1. Why it is needed (where the gap is)

The "people" we had originally grew out of intel items: a name appears in an item -> it is attributed to a person by alias.
That works, but it lacks three things, and all three are **structured facts that scraping news will never assemble**:

| Missing | Consequence |
| --- | --- |
| **Agency (circle)** | The heat map, shared silence hours and agency-level signals of "agency view" all require every person to have Agency filled in by hand. An agency of 30 people means filling it in by hand 30 times |
| **Multilingual names / aliases** | A Chinese name, a Japanese name and an English name each have to be written out before they match; however good Latin word-boundary matching is, unfilled aliases match nothing |
| **Per-platform accounts** | The same person's ids on bilibili / YouTube / Twitch / X are entered in scattered places, and missing one means missing one intel item |

VDB (`github.com/dd-center/vdb`, the upstream database behind vtbs.moe) does exactly this: **one file per person**,
and each record looks like this --

```json
{
  "name": { "cn": "嘉然", "en": "Diana" },
  "accounts": { "bilibili": "672328094", "weibo": "7595006312" },
  "group": "A-SOUL"
}
```

## 2. Why "one request fetches the whole database"

Measured (2026): the whole database tarball is **0.54 MB**, **10035 records**, **215 agencies**, fetched in one `codeload` request in one or two seconds.

By comparison, calling the GitHub API item by item means thousands of requests, consumed quota, rate limiting, and pure noise in the logs -- noisier for the user and less polite to upstream.
So we chose **a whole-database snapshot + a local index**, with a cache TTL of 7 days (the roster changes very slowly; to refresh it immediately, click "Sync roster" (UI string: `同步花名册`)).

### Measured composition

| Item | Count |
| --- | --- |
| Total records | 10035 |
| Agencies | 215 |
| Records with an agency attribution | 1770 |
| By platform (records with an account on that platform) | bilibili 9734 · twitter 680 · youtube 616 · youtubeAt 48 · twitch 45 · acfun 36 · weibo 30 … |
| Largest agencies by member count | VirtuaReal 115 · NIJISANJI 104 · ChaosLiveSprout 52 · 极光社 (Aurora Circle) 51 · P-SP 36 · HoloLIVE 35 |

> Note: **only 17.6% have an agency**. The vast majority of independents simply have no agency; this is not a data defect, it is reality.
> So the UI does not treat "no agency" as an anomaly, and agency view only takes effect for people who actually have an Agency filled in.

## 3. Licence (this section matters more than the feature itself)

VDB's data is **CC BY-NC-SA 4.0**, its code is **GPL**. We are MIT. The conclusions:

- ✅ **Fetched only at runtime**: the user clicks before anything is downloaded, and it is cached in the runtime directory `app/vdb/index.json`
- ❌ **Never enters the repository, never enters the release package**: `vdb/` is in `.gitignore`, and `tools/make-zip.mjs` and
  `tools/verify-release.cjs` both list `app/vdb` in their exclusion/verification lists -- committing the cache gets caught by the check
- ✅ **Attribution**: the roster block in the UI shows `dd-center/vdb · CC BY-NC-SA 4.0`, and both the README and this page state the source
- ✅ **Non-commercial**: personal tooling use is fine; for commercial use, contact upstream yourself

Ownership and final say over this data rest with upstream. We only read it, cache it, do not rewrite it, and do not redistribute it.

## 4. Implementation

| File | What it does |
| --- | --- |
| `server/src/tar.js` | **Zero-dependency** tar reading: ustar / directories / GNU long names `L` / pax extended headers `x`. The pax length field is counted in **bytes** and must include its own digits |
| `server/src/vdb.js` | Download -> gunzip -> untar -> parse each JSON record -> build the index; `searchIndex` / `membersOfGroup` / `toPerson` |
| `server/src/people.js` | Aliases made **platform-agnostic**: `PLATFORM_URLS` generates four forms, "id / link with www / bare link / `@handle`" |
| `web/src/pages/People.jsx` | Search -> tick -> import (the roster block) |

### Platform-agnostic is a hard requirement

`PLATFORM_URLS` currently has **27 platforms**: bilibili · youtube · youtubeAt · twitter · twitch · tiktok · weibo ·
weiboByName · acfun · niconico · showroom · pixiv · afdian · ci-en · booth · fantia · marshmallow ·
userlocal · instagram · telegram · patreon · peing · 163music · line · github · web · other.

The code **does not special-case any platform**: whatever platforms exist under `accounts` are accepted, and both matching and display go through the generic "platform -> id" shape.
When searching, the account id or link form on **any platform** (a Twitch name, a YouTube channel, a Weibo id...) matches.

Two boundaries matter here, because they are easy to misread:

- These account fields are **data about people, not a connection to those sites**. A `bilibili` or `twitter`
  entry is a field name in somebody's roster record, matched **locally** against text this app already
  collected; nothing here fetches, queries or posts to that platform. The platform names are the roster's
  own vocabulary - which is why the roster kept its full platform set while every platform-specific fetcher
  in this build was removed.
- The alias layer reads `PLATFORM_URLS` as its allowlist (`LINK_KEYS`), so the list of platform keys is
  defined once: an account on a platform outside that table gets no alias rather than an invented one.

### Import goes through the same sanitising path

Import is not a back door: the selected records first pass through `toPerson()` into the standard follow-target shape, then **through the same
`sanitizePerson()` as manual addition** (id conflicts, alias length and link validity are all blocked there). Anything blocked is reported back
item by item as `skipped` with a reason, never silently dropped.

## 5. Upstream's criteria (and whether they agree with our rules)

One entry in VDB's own inclusion/deletion criteria is worth recording, because it **collided with a rule we designed independently**:

| Upstream criterion | Our counterpart |
| --- | --- |
| A record is only deleted when "historical information is removed... and **6 months of no activity**" | Our "stopped activity / graduated" determination is **≥6 months of no movement** (`DORMANT_DEFAULTS.months: 6`) |
| Agency inclusion requires **≥2 qualifying members** to corroborate attribution | Agency-level signals in agency view require **≥3 members** before drawing a conclusion (`SILENCE_DEFAULTS.minMembers`), the same caution |

The two sides arrived at the same order of magnitude independently, which counts as a cross-validation.

## 6. Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/vdb/status` | **Reads the cache only, no network** (works offline); returns `cached / count / groups / platforms / generatedAt / source / license` |
| POST | `/api/vdb/sync` | Actually downloads (0.54 MB in one request), `force` semantics |
| GET | `/api/vdb/search?q=&group=&limit=` | Names (any language/alias) and account ids / links on **any platform** all match; fetches once automatically when no cache exists |
| GET | `/api/vdb/groups` | Agency -> member count |
| POST | `/api/vdb/import` | Turns the selected keys into follow targets, returns `added` / `skipped` |

## 7. Self-check (`npm run test:vdb`, 25 items)

Offline assertions, no network:

- tar: ustar headers / directories / GNU `L` long names / pax `x` extended headers (including the trap that "the length field must include its own digits and is counted in bytes")
- parsing: `{name:{cn,en}}` multilingual names, missing fields, any platform under `accounts`
- index: agency grouping, platform counts, search (Chinese name / English name / bilibili mid / Twitch name / link with www / `@handle`)
- import: the shape from `toPerson()` is accepted by `sanitizePerson()`; duplicate names / duplicate ids are blocked
- **Reconciliation against the real tarball**: unpack the same archive with the machine's `tar.exe` and compare record counts item by item (our JS reader gets 10035 records, matching upstream's file count)

> About that reconciliation: the entry names `tar.exe` produced had mojibake (`-大咲-` -> `-婢堝瓙-`), which made its record count come out low.
> That in fact shows our reading path (explicitly decoding as UTF-8) is the correct one.

## 8. Not done / to watch

- **The snapshot is not bundled**: the licence forbids us from redistributing it (NC/SA), so the roster is unavailable in offline environments -- a deliberate trade-off
- **No incremental updates**: a whole-database snapshot every time. 0.54 MB / 7 days is not worth introducing the complexity of incrementality
- **Agency attribution conflicts are not adjudicated automatically**: when the same person is marked with different agencies in different places, the `group` in the VDB record wins; we do not guess
- **Graduation determination does not depend on VDB**: VDB is a roster, not a timeline, and has no "last activity time". The authoritative graduation signal still comes from our own
  items + silence detection (see `docs/DESIGN.md` §13). VDB only answers "which circle is this person in, and what other accounts do they have"

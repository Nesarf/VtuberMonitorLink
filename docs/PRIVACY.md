# Privacy & Publishing Notes / 隐私与发布须知

> This file states Vtuber's Monitor Link's privacy boundaries, and the cleanup that must be done before publishing (committing to a public repository / distributing the .exe).

## Our commitments

1. **No account or cookie is ever packaged or uploaded.**
   Sites that require login (for example a Twitch follow list, or any source you declare yourself) are always logged into by the user **in their own browser**;
   this tool only "borrows" that browser's profile to render pages, and what is stored in the configuration is the **browser path + profile directory**, not the credentials themselves.

2. **Nothing is ever sent back.**
   The tool only listens on `127.0.0.1`, and reports and scraping results only land on the local disk.

3. **Runtime data does not enter the repository.**
   `config.json` (which contains the LLM Key, proxy address and browser path), `reports/`, `feeds/` and `logs/` are all excluded in `.gitignore`.

## Pre-publish checklist / 发布前必做

```bash
npm run sanitize-check
```

That script scans every text file in the repository and reports:

| Rule | What it checks |
| --- | --- |
| `home-path` | Personal home directory paths (such as `C:\Users\<name>`) |
| `specific-drive` | Hardcoded absolute paths with a drive letter |
| `api-key` | Suspected API keys (`sk-…`) |
| `cookie-blob` | Suspected cookie content (`cf_clearance` / `SID=` / `__Secure-` …) |
| `named-persona` | Personalised identifiers such as private persona names |
| `runtime-data` | Whether runtime data/directories were mistakenly put into the repository |

### The history, not just the tree

`npm run sanitize-check` reads the working tree, which answers "is the repository clean now" - not the same
question as "is anything personal reachable in it". A file deleted in a later commit is still inside the commits
that contain it, `git log -p` shows it to anyone who asks, and a clone brings all of it along. That is how a key
that was "removed ages ago" stays published.

`npm run sanitize:history` therefore runs the **same rules and the same exemptions** (`sanitize-rules.mjs` is the
one definition, so the two scanners cannot disagree) over every text blob that has ever been committed - 1170 of
them at the time of writing - and masks what it finds, because a scanner that prints the match has just written
it into a new place: a terminal, a public CI log, a transcript.

Measured on this repository (2026-09-15): **no API key, no cookie content, no private name, no personal home
directory path in any commit.** What it does find are machine drive paths in *older* versions of test fixtures
and documentation examples; the current versions exempt those lines, which is why the tree scan is clean while
the history scan is not. Rewriting the history to remove a fixture's drive letter would break every clone and
fork for no privacy gain, so those are accepted **by name and by count** in
`server/scripts/sanitize-history.baseline.json` and anything new fails the build. The baseline is meant to be
read when it changes; `--update` rewrites it, and belongs in a commit that says why.

If the scan ever reports a key, a cookie or a name, editing a file will not fix it: the history has to be
rewritten (`git filter-repo` / BFG, then a force-push) **and the credential has to be rotated**, because a value
that reached a public clone must be treated as known. Rotating first, rewriting afterwards, is the safe order.

## Developer notes

- Do **not** hardcode any absolute path in the code; everything goes through `config.json` (see `DEFAULT_CONFIG` in `server/src/config.js`).
- Built-in source list metadata (`server/src/sources.js`) contains **public URLs only**, and no personal configuration.
- When adding a new source, fill in public endpoints only; do **not** put a private address carrying a token / cookie into the list.
- If an example configuration is needed, use a placeholder file such as `config.example.json`, and it **must not** contain a real Key.

## Distribution form

- **Portable package**: `VtuberMonitorLink.exe` (a single-file launcher) + `app/`, unzip and run;
  the package **contains no** user data, account, cookie or Key.
- `app/config.json` is generated on first run, and the user fills in the LLM Key, browser path and proxy themselves.
- The packaging script refuses to copy `config.json`, `reports/`, `feeds/`, `logs/` and `watch/` into the artefact;
  before publishing, run `npm run verify` for an independent second pass (which includes the item "has a Key been filled in").

## Where local credentials live

This tool uses two kinds of credential, and **both are written only to the local `app/config.json`**:

| Credential | Purpose | Notes |
| --- | --- | --- |
| LLM API Key | Calls your own model endpoint | The endpoint only returns it masked as `***`; to edit it, click "Show" in the web UI (UI string: `显示`) |
| Moegirl BotPassword | Reads your own watchlist | An optional feature. **Do not use the main password**; a BotPassword with read-only rights is recommended |

Neither of them enters the version repository (`config.json` is in `.gitignore`), nor the release package.
The same applies to the list of private names in `.sanitize-names`.

## Browser login state (`server/src/cookies.js`)

Some sources have to be logged in to scrape (the Twitch following list, a wiki watchlist, a source you
declare yourself). This tool offers two routes, and **by default neither writes cookies to any persistent
location**:

### Route A: read-only extraction (recommended; the browser can stay open)

Firefox's cookie store (`cookies.sqlite`) is **copied** to a temporary directory and then read: the temporary copy
is deleted once used, and the original profile is neither locked nor modified.

- The mechanism is **generic**: it reads the host the caller names (the Browser page's field starts at
  `reddit.com`, and any host can be typed in), and it carries no per-site list of what a login looks like -
  the one thing it recognises is the *shape* of a session-cookie name;
- Only the host you specify is read; all other domains are left untouched;
- The values are assembled into a single Cookie header **in this process's memory only**, and are
  never written to disk. Nothing in this build sends that header: the login surfaces report cookie **names**
  and counts, which is all the check needs. The header assembly stays because it is what a site-specific
  caller would use - the mechanism was kept, the per-site callers went with their platforms;
- **No log, no report, nothing into `feeds/`**; `POST /api/cookies/check` returns only
  "which cookie names were read", never a value;
- A directory that is **not** a Firefox profile answers as its own state (`no-firefox-profile`) rather than as
  "not signed in". A Chromium profile directory is not a store this reader can open, and a blanket "no cookies"
  would have described a missing store as an absent login;
- The original profile is never modified, so this works while Firefox is open.

Measured: **Firefox keeps cookie values in plaintext** (`cookies.sqlite`, table `moz_cookies`). There is no key
to find, so there is no decryption step that can fail - either the cookie is read, or the profile simply has none
for that domain. The whole Chromium key pipeline this route used to describe (DPAPI via a local `powershell.exe`
subprocess, the `v10` AES-256-GCM envelope, the 32-byte domain-binding prefix, and the App-Bound Encryption
`v20` state that could not be decrypted externally and sent you to route B) is **deleted rather than disabled**,
along with the platform gate: reading a SQLite file is not a Windows-only operation.

### Route B: Playwright reusing a profile

Point `profileDir` at a Firefox profile that is logged in and Playwright starts with a persistent context.
**That Firefox must be fully closed** (otherwise the profile is locked); the cost is higher, but this route is
what carries a login the read-only probe cannot see.

> If you do not want any tool reading your cookies, do not configure `profileDir`:
> when it is not configured, no extraction is performed, and sources that need login fail honestly with a hint.

## What the browser's own traffic does (egress)

A browser-rendered fetch and a screenshot both go out through **this project's egress**, not straight from the
machine: `resolveBrowserEgress()` in `server/src/net.js` resolves the route with the same `resolveProxyMode()`
every other fetch uses, so a source pinned to Tor renders through Tor rather than through the global mode.

- **The Tor SOCKS port is probed before a browser is started.** When Tor is not running the answer is a sentence
  naming the SOCKS port and no browser is launched - a browser is never started on the assumption that Tor will
  come up. (Measured: a browser launched against a refusing SOCKS port fails the navigation rather than falling
  back to a direct connection, so a probe that passes is not hiding a working direct path.)
- **Thumbnails are on that same egress.** They used to hand-roll "HTTP proxy or nothing", which meant a
  screenshot taken while Tor mode was on went out **direct** - a privacy setting that quietly took a picture of a
  page from this machine's own address.
- **One measured engine limit, stated rather than hidden**: Playwright's Firefox cannot authenticate to a SOCKS5
  proxy (it offers only the no-authentication method, and Firefox's own `network.proxy.socks_username` /
  `socks_password` prefs change nothing). Browser traffic through Tor therefore rides the **default circuit**.
  The per-subject `IsolateSOCKSAuth` rotation still applies to every non-browser fetch, and no username is put on
  the browser's proxy at all - putting one there would only have looked like isolation while the wire carried none.

## Confirm before going live

`npm run verify` and `npm run traverse*` going all green only means **the program itself** is fine; it does not mean
it has been run through with a real Key. The product's first full run (scrape -> watch -> LLM analysis -> report) requires the
user to fill in the LLM API Key in the web "Settings" page themselves, and that step is deliberately kept out of the automated flow:
the Key should exist only in the user's local `app/config.json`, never in the repository, never in the release package.

To get the whole chain running with no Key at all, use the local mock LLM that ships with the repository:

```bash
npm run mock-llm      # 127.0.0.1:43197, OpenAI-compatible, zero dependencies
```

That is what `npm run traverse:ui` does -- it temporarily writes a configuration pointing at the mock,
and restores `app/` to a clean state afterwards.

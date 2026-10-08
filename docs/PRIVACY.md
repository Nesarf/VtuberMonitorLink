# Privacy & Publishing Notes / 隐私与发布须知

> This file states Vtuber's Monitor Link's privacy boundaries, and the cleanup that must be done before publishing (committing to a public repository / distributing the .exe).
>
> `SECURITY.md` in the project repository is the companion document: the threat model, where the secrets live, which
> component may read a browser profile, the URL policy and how to report a vulnerability. This file is the shorter
> privacy-facing view of the same facts, plus the publish checklist.

## Our commitments

1. **No account or cookie is ever packaged or uploaded.**
   Sites that require login (for example a Twitch follow list, or any source you declare yourself) are always logged into by the user **in their own browser**;
   this tool only "borrows" that browser's profile to render pages, and what is stored in the configuration is the **browser path + profile directory**, not the credentials themselves.

2. **Nothing is sent back to this project — and what does leave the machine is listed, not implied.**
   There is no upload, no analytics, no crash report and no update check: reports, feeds and scraping results land
   only on the local disk, and the API listens on `127.0.0.1` only (and now enforces that — see "The API is
   loopback-only" below). The old wording stopped there, which was too easy to read as "nothing ever leaves".
   What leaves is what **you** configure: the sites being scraped, the LLM endpoint you chose, the notification
   targets you set up. Each row is enumerated in "What is sent where" below.

3. **Runtime data does not enter the repository.**
   `config.json` (which contains the LLM Key, proxy address and browser path), `reports/`, `feeds/` and `logs/` are all excluded in `.gitignore`.

## What is sent where

Feature by feature, this is everything that leaves the machine. Nothing else does — there is no telemetry channel
to enumerate.

| Feature | Destination | What is sent | Credential that rides along |
| --- | --- | --- | --- |
| Source fetch (RSS/Atom, MediaWiki API) | the source's own host, via the egress set for it | the request for that feed/page (address, path, query, a generic `User-Agent`) | none |
| Browser-rendered source | the source's host **plus everything the page itself requests** | ordinary browser requests; with `browser.profileDir` set, that profile's cookies, which *is* the login | the login already in the profile you pointed at |
| Watch target | the wiki's `api.php` host | read-only `meta=userinfo` requests and the reads that produce the diff | the wiki BotPassword, in an `Authorization` header (never in the URL) |
| LLM analysis / feature extraction / search assistant | the LLM base URL of the active profile | the condensed digest of the fetched items (titles, links, summaries) and the prompt; your search query | that profile's API key |
| Vision tagging (**off by default**) | the profile named by `vision.providerId` | the image URL of the item plus a short context line | that profile's API key |
| Notifications | the target you configured (Bark, ServerChan, Telegram, DingTalk, WeCom, ntfy, Gotify, PushPlus, Slack, Discord, Feishu, custom webhook) | the notification title and body | that target's own token / webhook URL |
| Desktop notification | this machine | nothing | — |
| Egress probe | the address being probed | a TCP connect and/or one small HTTP request per egress tier | none |
| Roster download (VDB) | `vdb.url` (upstream `dd-center/vdb` by default) | one request of about half a megabyte | none |
| Thumbnails / screenshots | the page's own host | icon / `og:image` / page requests, on the source's egress | none |

Three fixed addresses are contacted as constants rather than as user input, and are named here so they are not a
surprise: `cloudflare.com/cdn-cgi/trace` (which country an exit appears to be in), `check.torproject.org/api/ip`
(the Tor reachability check) and `api.ipify.org` (used once to recognise a local proxy).

**Publishing is not in the table** because this build has no code that posts to a site: every entry in
`SHARE_SITES` declares `implemented: false`, `/api/share/post` refuses for that reason behind its
explicit-confirm gate, and the hand-off it offers opens the site's own compose page **in your browser** — anything
published there is sent by your browser and your account, not by this app.

One honest note about a setting you can see in the UI: `privacy.anonymousMode` is enforced centrally (see the
cookie section below), but **`privacy.sendReferer` is not read by anything in this tree** — grep finds the config
default, the switch on the settings page, and no consumer. No fetcher in this build sets a `Referer` or `Origin`
header at all, so there is nothing for that switch to turn on or off today; it is recorded here so it is not
mistaken for a control that is protecting anything.

## The API is loopback-only, and now enforces it

The service binds `127.0.0.1` (`server/src/index.js`), and since v1.0.5 every request is also *checked*: a
`Host` header naming loopback and an absent-or-loopback `Origin` are required, and anything else gets `403` with a
JSON body (`server/src/request-guard.js`). This is what closes **DNS rebinding** — a page can point a name it owns
at `127.0.0.1`, and without the `Host` check the request looks like a normal visit *and* its response is readable
by that page. The practical consequence for a user: a request to your local API from any other name, including a
name that resolves to loopback, is refused, and the refusal says which header was wrong.

Because the API is reachable by any process running as your user, it is not a second factor, and the config it
serves is masked for the same reason (see the credential table below).

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
- The packaging script builds `app/` from `server/`, `web/dist/` and `docs/` (plus the two Readmes and `LICENSE`),
  and additionally refuses `config.json`, `reports/`, `feeds/` and `logs/` by name, so a release artefact cannot
  contain them; while rebuilding over an existing `app/` it deliberately **keeps** that folder's runtime state, so
  a rebuild does not delete the config it is supposed to sit beside.
- Before publishing, run `npm run verify` for an independent second pass (which includes the item "has a Key been filled in").

## Where local credentials live

Every credential this tool stores is written **only to the local `app/config.json`** (or, in a source checkout, the
`config.json` at the repository root):

| Credential | Purpose | Notes |
| --- | --- | --- |
| LLM API Key | Calls your own model endpoint | The API answers with the mask `***`, plus a `hasApiKey` boolean for the page. Typing a new value replaces the stored one; the "Show" toggle only switches that input between password and plain text — it does **not** fetch the stored key back |
| Moegirl BotPassword | Reads your own watchlist | An optional feature. **Do not use the main password**; a BotPassword with read-only rights is recommended |
| Notification tokens / webhook URLs | Push alerts to the targets you set up | Held per target in `notify.targets` |
| Local proxy control secret | Talks to a mihomo/Clash external-controller | `proxy.controlSecret`; empty unless you configured the node API |

**The file is plaintext.** There is no keychain and no vault: file permissions are the only protection it has, and
in the portable build the file sits inside the unzipped folder, so copying that folder (a USB stick, a shared
drive, a synced directory, a backup) hands over every key it holds. Treat the packed `app/` folder as the secret.

Masking is by **field name at any depth** (`publicConfig()` in `server/src/config.js`), so a new secret field is
covered automatically and the same rule applies inside arrays; a masked or blank value arriving in a request body
means "unchanged" rather than "store this", which is what stops a settings-page save from wiping a key. The
redacted config export blanks the same fields; `GET /api/config/export?secrets=1` is the deliberate variant that
writes plaintext into the file you download.

None of these enters the version repository (`config.json` is in `.gitignore`), nor the release package.
The same applies to the list of private names in `.sanitize-names`.

## Browser login state (`server/src/cookies.js`)

Some sources have to be logged in to scrape (the Twitch following list, a wiki watchlist, a source you
declare yourself). This tool offers two routes, and **by default neither writes cookies to any persistent
location**:

### Who is allowed to read a profile

One module resolves the profile — `server/src/browser-target.js` (`resolveProfileDir` / `resolveProfileTarget`) —
and `privacy.anonymousMode` is enforced **inside it**, so the switch holds for every feature at once rather than
for whichever ones remembered. `server/src/browser-consumers.js` is the declared list of consumers (what each one
needs and whether it is satisfied), and a structural check fails the build if a consumer reads `browser.profileDir`
on its own. `server/src/cookies.js` is the **only** module that opens a cookie store. With `browser.profileDir`
empty there is nothing to read and nothing is read, and browser-rendered sources still work on a clean temporary
profile.

### Route A: read-only extraction (recommended; the browser can stay open)

Firefox's cookie store (`cookies.sqlite`) is **copied** — together with its `-wal`/`-shm` companions — into a fresh
directory under `paths.tempDir` (the system temp directory by default), opened with a read-only SQLite connection,
and the whole temporary directory is deleted in a `finally` block. The original profile is never locked, written or
modified, so this works while Firefox is open.

- The mechanism is **generic**: it reads the host the caller names (the Browser page's field starts at
  `reddit.com`, and any host can be typed in), and it carries no per-site list of what a login looks like -
  the one thing it recognises is the *shape* of a session-cookie name;
- Only the host you specify is read; all other domains are left untouched;
- The values are assembled into a single Cookie header **in this process's memory only**; that header is never
  written to disk, and nothing in this build sends it: the login surfaces report cookie **names**
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
**Any other Firefox using that profile must be fully closed** (otherwise the profile is locked); the cost is higher,
but this route is what carries a login the read-only probe cannot see.

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
- **The browser is also judged request by request, not just at launch.** The egress decides *where* the browser
  goes out; a separate rule decides *which addresses it may reach*. Playwright's `page.route` hands every request
  the page is about to make - each redirect hop, each subresource - to the same policy the server-side fetches use
  (`server/src/remote-url.js`), and a refused request is aborted before a socket is opened and makes the render
  report a failure instead of describing a page that never fully loaded.

### The URL policy: what this app will not fetch

One implementation holds the rules for every address the app fetches on behalf of a user or the config
(`server/src/remote-url.js`, reached through `net.js` for HTTP fetches and through `page.route` for the browser).
It refuses, with a reason code: any scheme other than http/https; loopback (`127.0.0.0/8`, `::1`, IPv4-mapped
forms, `localhost` and `*.localhost`); the private ranges including CGNAT `100.64/10` and unique-local IPv6;
link-local and the cloud metadata addresses inside it; `0.0.0.0` / `::` / an empty host; userinfo in the URL
(because this project logs the addresses it fetches); and a name that does not resolve or resolves to nothing.
Names are resolved and the *answers* are checked, and a mixed answer containing one refused address is refused as a
whole. Redirects are walked hop by hop (eight hops at most, method switching per the fetch spec, a self-loop
refused), because the network library would otherwise follow a chain internally where no hop can be inspected.

**Loopback is refused by default, and the allowance is per entry.** A source, a watch target, a notification
webhook, an LLM profile or a roster address that points at this machine needs `"allowLoopback": true` on that one
entry in `config.json`; the flag relaxes the loopback rule **only** (a private, link-local or metadata address
stays refused), and there is deliberately no UI switch for it. The shipped **Ollama preset carries the flag**,
because a local model server is loopback by design — but a profile you typed pointing at `127.0.0.1` does not, and a
config that pointed at loopback before this release will now be refused until you add it. `SECURITY.md` has the
table of where the flag goes.

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

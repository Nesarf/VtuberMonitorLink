# Security policy

> Vtuber's Monitor Link (VML) is a **local tool**: one Node process that serves a web UI to `127.0.0.1`, plus the
> pages in your browser. It has no accounts of its own, it talks to no service belonging to this project, and it
> sends no telemetry. It does, however, hold real credentials for services *you* configure, and fetching addresses
> *you* supply is the whole point of the product — so this document states, concretely, what stays on the machine,
> what leaves it, where the secrets live, which code is allowed to read a browser profile, and which addresses the
> app will refuse to fetch.

The reasoning behind each of these is in `docs/DESIGN.md` §15 (the config file) and §16 (the URL policy); the
release history is in `docs/RELEASE.md`.

## Supported versions

- **The supported line is the current `1.0.x` release.** The repository has one branch (`main`) and release tags
  (`v1.0.0` … `v1.0.4` at the time of writing), and fixes are made on the tip and shipped in the next release —
  there is no maintained older branch to backport to. `package.json` carries the exact version of the tree you are
  reading.
- The three changes of the v1.0.5 security round are the ones described here: secrets no longer leave the process
  and the API refuses non-loopback hosts, a damaged config is preserved instead of silently replaced, and one
  URL policy now governs every address the app fetches.
- Security fixes are ordinary commits with an English message that states what was measured and what the evidence
  is; `git log` is the record, and the tests named below are the proof.

## The trust boundary

- **The API listens on loopback only.** `server/src/index.js` binds `127.0.0.1` (port `43110`; the `PORT`
  environment variable overrides the port, not the interface). There is no setting that exposes it to a network.
- **And the API now *enforces* that**, rather than assuming the bind address is enough. `server/src/request-guard.js`
  runs before the body parser on every request and requires:
  1. a `Host` header naming loopback (`127.0.0.1`, any other `127.x` address, `localhost`, `::1`, with or without
     a port) — the header is derived from the URL the page navigated to, so a cross-origin page cannot forge it;
  2. an `Origin` header that is **absent or loopback** — our own pages send none on a same-origin GET, and a
     present one is a statement that can be checked.
  A refusal is `403` with a JSON body and `Vary: Origin`; nothing is routed and no data is produced.
- **What this closes: DNS rebinding.** "It only listens on loopback" was previously the whole argument, and the
  second half of that argument is wrong in one way that matters. A page on any site can point a name it controls at
  `127.0.0.1`; the browser then sends its request to this port with `Host: <the attacker's name>`, and from inside
  the server that is indistinguishable from a normal visit. The response is also *readable* by that page, because
  the browser considers the request same-origin with the attacker's own name. That is what turned "it only listens
  on loopback" into a full read of a config holding an LLM API key and a wiki BotPassword.
- **What follows from the boundary, stated plainly:** any process that runs as your user can read your config
  (secrets masked) and write it through this API. The API is not a second factor and was never meant to be one.
  "Another program on my own machine can call it" is by design, not a vulnerability report we can act on.

## What stays on the machine

Everything the app produces is local, under the directory the config points at (`paths.*`, resolved against the
app root unless absolute):

| Where | What it holds |
| --- | --- |
| `config.json` | **Every credential this app stores**: LLM API keys, the optional wiki BotPassword, notification tokens and webhook URLs, the local proxy control secret, and all your settings |
| `config.json.bak` | The previous good config, written before every save — the one step back |
| `config.json.broken-<stamp>` | A config file that did not parse, preserved as found (see "A damaged config" below) |
| `reports/`, `feeds/` | Reports and the raw fetched items they were built from, plus the SQLite archive and the feature cache |
| `logs/`, `advice/` | The server log, run records, probe/quarantine/observation state, and self-check diagnostics |
| `watch/` | Per-target baselines and change history |
| `thumbs/`, `vdb/` | Thumbnail cache and the downloaded roster index |
| the temporary directory | Copies made while reading a browser cookie store, and fetch temp files; `paths.tempDir` moves it, and it defaults to the system temp directory |

`config.json`, `reports/`, `feeds/`, `logs/`, `watch/`, `thumbs/`, `advice/` and `vdb/` are all in `.gitignore`. A
release artefact cannot contain them either: the packaging script builds `app/` out of `server/`, `web/dist/` and
`docs/` only (plus the two Readmes and `LICENSE`), and it additionally refuses `config.json`, `reports/`, `feeds/`
and `logs/` by name — while deliberately preserving the runtime state of an existing `app/` when you rebuild over
it, so a rebuild does not delete the config it is meant to keep beside the program.

## What leaves the machine

"Nothing is ever sent back" was the old wording. It is true about *this project* — there is no upload, no
analytics, no crash reporting, no update check — but it is not true about the destinations **you** configure. This
table is the honest version: for each feature, where the data goes, what goes, and what credential rides along.

| Feature | Destination | What leaves | Credential |
| --- | --- | --- | --- |
| Source fetch — RSS/Atom, MediaWiki API (`fetchers/rss.js`, `fetchers/mediawiki.js`) | the source's own host, through the egress configured for it | the request for that feed or page (address, path, query, a generic `User-Agent`) | none |
| Browser-rendered source (`fetchers/browser.js`) | the source's host **and every address the page itself requests** — subresources included, because the page chooses them | ordinary browser requests from the Firefox build this app launches; with `browser.profileDir` set, that profile's own cookies are presented, which *is* the login | only the login already stored in the profile you pointed it at |
| Watch target (`watch.js`) | the wiki's `api.php` host | read-only `meta=userinfo`/`assert=user` requests and the page or API reads that produce the diff | the wiki BotPassword, sent in an `Authorization` header — never in the URL, because this app logs the addresses it fetches |
| LLM analysis, feature extraction, the search assistant (`analyze.js`, `features.js`, `search` route) | the base URL of the active LLM profile — a public provider, or a machine you run | the condensed digest of the items just fetched (titles, links, summaries) plus the prompt; for the search assistant, the query you typed | that profile's API key as a bearer token |
| Vision tagging (`vision.js`) — **off by default** (`vision.enabled`) | the profile named by `vision.providerId`, or the active one | the item's image URL (the provider fetches the image) plus a short context line | that profile's API key |
| Notifications (`notify.js`) | the target you configured: Bark, ServerChan, Telegram, DingTalk, WeCom, ntfy, Gotify, PushPlus, Slack, Discord, Feishu, or a custom webhook | the notification title and body text | that target's own token, key, chat id or webhook URL |
| Desktop notifications | this machine only | nothing | — |
| Egress probe (`/api/probe`, self-check) | the address being probed | a TCP connect and/or an HTTP request per egress tier | none |
| Roster download (`vdb.js`) | `vdb.url`, by default the upstream `dd-center/vdb` tarball | one request of roughly half a megabyte, with the software tag `VML` | none |
| Thumbnails and screenshots (`thumbs.js`) | the page's own host (icon, `og:image`, screenshot) | image and page requests on the same egress as the source they belong to | none |
| Local proxy control (`proxyctl.js`) | the mihomo/Clash external-controller you configured, normally on loopback | node list, node switch and delay-measurement requests | `proxy.controlSecret` |
| `GET /api/config/export?secrets=1` | a file your browser downloads, i.e. this machine | the **whole config including plaintext secrets**, deliberately | — |
| `tools/i18n-translate.mjs` (a developer tool, not the app) | the OpenAI-compatible endpoint you pass on the command line | the UI source strings being translated | the key you pass |

Three addresses are contacted as **fixed constants** rather than as user input, and they are named here so they are
not a surprise: `cloudflare.com/cdn-cgi/trace` (which country an exit appears to be in, during a probe),
`check.torproject.org/api/ip` (the Tor reachability check) and `api.ipify.org` (used once to recognise a local
proxy). They are listed in `URL_POLICY_EXEMPT` in `server/src/remote-url.js`, with the reason each is exempt, and a
structural check fails the build if a module that is exempt starts reading a user-supplied address.

Publishing is *not* in that table because **this build has no code path that posts to a site**: every entry in
`SHARE_SITES` (`share.js`) declares `implemented: false`, `/api/share/post` refuses for that stated reason behind
its explicit-confirm and audit gate, and the hand-off it offers opens the site's own compose page **in your
browser**, so anything you publish there is sent by your browser and your account, not by this app.

## Which component may read a browser profile

- **One resolver, and anonymous mode lives inside it.** `server/src/browser-target.js` is the only place a profile
  directory is resolved (`resolveProfileDir` / `resolveProfileTarget`). `privacy.anonymousMode` is enforced there
  rather than by each consumer remembering, so it holds for every feature at once; the consumers and what each one
  needs are declared in `server/src/browser-consumers.js`, and a structural check fails the build if a consumer
  reads `browser.profileDir` on its own. If `browser.profileDir` is empty, there is nothing to read and nothing is
  read — browser-rendered sources still work on a clean temporary profile.
- **One reader, and the read is read-only.** `server/src/cookies.js` is the only module that opens a browser
  cookie store:
  - it **copies** the store (plus its `-wal`/`-shm` companions) into a fresh directory under `paths.tempDir`, opens
    the copy with a read-only SQLite connection, and deletes the whole temporary directory in a `finally` block —
    the original profile is never locked, written or modified, so this works while Firefox is open;
  - Firefox keeps cookie values in **plaintext** (`cookies.sqlite`, table `moz_cookies`), so there is no key
    pipeline to fail and no decryption step to get wrong. Values are read for the host the caller names and
    assembled into a cookie header **in memory only**; what any caller in this build sends back is cookie *names*
    and counts, never a value, and nothing is written to a log, a report or `feeds/`;
  - a directory that is not a Firefox profile answers as its own state (`no-firefox-profile`) rather than as "not
    signed in".
- **Route B: handing a profile to the browser.** With `browser.profileDir` set, `fetchers/browser.js` starts the
  bundled Firefox with a *persistent context* over that profile, so the site sees a real logged-in session. Any
  other Firefox using that profile must be closed while it runs (the profile is locked otherwise). This is the only
  path where a login state is actively presented to a site rather than read locally.

## Where the secrets live

- **A local `config.json`, and nothing else.** There is no keychain, no vault and no account: the file next to the
  application (a source checkout keeps it at the repository root; a packaged release keeps it in the unpacked
  folder) holds the secrets in plaintext, and the file's permissions are the only protection it has.
- **Portable mode is the less safe of the two shapes — plainly:** the config then sits *inside the folder you
  unzip*, so it travels with that folder. Copying it to a USB stick, a shared drive, a synced folder or a backup
  hands over every key it holds; unzipping it on another machine gives that machine your credentials. A source
  checkout on an account you control is the safer arrangement, and if you do use the portable build, treat the
  whole folder as the secret rather than only `config.json`.
- **What the API returns is masked, by construction.** `GET /api/config`, `GET /api/llm/presets`, `GET /api/watch`,
  and the responses of the write routes all go through `publicConfig()` (`server/src/config.js`), which replaces
  every leaf whose **field name** matches the secret pattern — at any depth, inside objects and inside arrays —
  with `***`, and adds a `hasXxx` boolean next to it so the UI can say "a key is set" without the value travelling.
  A new secret field is covered automatically by its name; a look-alike that must stay readable is opted out
  explicitly in `PUBLIC_FIELDS` by full path, so an exemption is always a written decision rather than an inference
  from a name. The write side is the same rule in reverse (`preserveSecretStrings`): a masked or
  blank secret arriving in a request body means **unchanged**, never "store this", array entries are matched by
  `id` rather than by position, and the derived `hasXxx` is dropped so it is never persisted.
- **The UI never gets the stored key back.** The LLM key field shows the mask; typing a new value replaces it, and
  the "Show" toggle only switches that input between password and plain text — it does not fetch the secret.
- **Export is redacted by default.** `GET /api/config/export` blanks and masks every secret; the `?secrets=1`
  variant is the deliberate "back up everything" switch and does write plaintext into the file you download.
  Importing a redacted export will not wipe the secrets already on the machine.
- **If a key may have leaked, rotate it first, then clean up.** A credential that reached a clone, a screenshot, a
  chat message or a public log must be treated as known; rotating the key is what actually ends the exposure.

## A damaged config is preserved, not silently replaced

A config that does not parse used to look exactly like a fresh install, and the next save then wrote the
**defaults** over it — the user lost the file that could have been repaired. The loader now distinguishes four
states (`CONFIG_STATES` in `server/src/config.js`):

| State | What happened | What the app does |
| --- | --- | --- |
| `fresh` | no config file yet | defaults; nothing written; reported as a first run, not a fault |
| `ok` | the file parsed | normal operation |
| `corrupt` | the file did not parse | the file is **copied** to `config.json.broken-<stamp>` and then removed, never written over; the app runs on defaults and says so |
| `unreadable` | permissions (or a directory) | the file is left **exactly as found**; the app runs on defaults and says so |

In the two fault states the app genuinely runs on defaults — a local tool that refuses to start over one byte is
worse than one that starts degraded and says why — but the condition is persistent and visible: one startup line
naming the state and the preserved filename, `GET /api/config/health`, and a log warning on every later write. A
successful write deliberately does **not** clear the load result.

Writes are atomic: a temp file **in the target's own directory**, an `fsync` of that file, a copy of the current
file to `config.json.bak`, one `rename` over the target, then an `fsync` of the directory (refused on Windows and
recorded rather than thrown, because a rename that already happened must not be reported as a failed write). Any
failure before the rename leaves the previous file byte-identical and removes the temp file. `POST
/api/config/recover` puts the backup back — and refuses to overwrite an existing `config.json`, because restoring
a backup behind your back would be the same silent substitution in a new costume.

## The URL policy: which addresses this app will fetch

Every address the app fetches on behalf of a user or the config is judged by **one** implementation,
`server/src/remote-url.js`. There is no second copy of the rules to drift: a structural check reads the inventory
exported by that file and fails the build when a module performs a network call without referencing it, or when a
module starts spelling out the ranges itself.

**Refused, with the reason recorded in `URL_POLICY_CODES`:**

| Refused | Why it is on the list |
| --- | --- |
| Any scheme other than `http` / `https` | `file:` reads a local path with this process's rights, `data:`/`javascript:` have no host to check |
| Loopback — `127.0.0.0/8`, `::1`, IPv4-mapped forms, and the names `localhost`, `*.localhost` | this app serves its own API on loopback, and that API can write the config |
| Private ranges — `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (CGNAT), `fc00::/7` | the LAN: routers, NAS boxes and other people's machines |
| Link-local — `169.254/16`, `fe80::/10`; and the cloud metadata addresses inside it | cloud instance credentials live there |
| Unspecified — `0.0.0.0`, `::`, an empty host | a way of writing loopback without writing `127.0.0.1` |
| Userinfo in the URL | this project logs the addresses it fetches; a password in the URL would ride along into the log (the wiki credential is sent as a header for exactly this reason) |
| A name that does not resolve, or resolves to an empty list | the addresses of an unresolved name were never inspected |
| An IPv6 zone id | a client that strips it reaches the address behind it |

**A name is not an address**, so names are resolved and the *answers* are checked; a mixed answer containing one
refused address is refused as a whole, because "which one did we get this time" is not a security property.
`skipDns` is set automatically when a proxy or a Tor exit is the one doing the resolving, since asking whether
*this* machine can resolve a name is then a statement about the wrong machine.

**Redirects are walked hop by hop**, because the network library otherwise follows a chain internally and this
process never sees the intermediate addresses: `netFetch` forces `redirect: 'manual'` and checks every hop with
the same policy, resolving relative `Location` values, switching method to GET where the fetch spec says to, and
refusing more than eight hops or a redirect that points back at itself. In the browser the equivalent seam is
Playwright's `page.route`: every request the page is about to make — each redirect hop and each subresource — is
offered to the same policy first and aborted if refused, and a refused request makes the render report a failure
rather than a page that loaded.

### What to do if you deliberately want a local endpoint

The policy is off-by-default and **per entry**: add `"allowLoopback": true` to that one entry in `config.json`.

| Entry | Where the flag goes |
| --- | --- |
| A custom source that lives on this machine | the entry in `customSources` |
| A watch target | the target object in `watch.targets` |
| A notification webhook on this machine | the target object in `notify.targets` |
| A local model server (Ollama, llama.cpp, LM Studio…) | the profile object in `llm.providers` |
| A roster mirror on this machine | `vdb.allowLoopback` |

- The flag relaxes **the loopback rule only**. A private-range, link-local or metadata address is still refused
  with it set — it is not "allow anything local".
- There is no switch in the web UI for it, and that is deliberate rather than an omission: it has to be a config
  edit, so it cannot be flipped on for everything by one click.
- **The shipped Ollama preset already carries it** (`PRESETS` in `server/src/llm.js`), and it is copied onto the
  profile explicitly when the preset is used, because a local model server is loopback by design and a preset
  refused on first use teaches people to turn the rule off wholesale. The flag stays per entry, so this admits the
  Ollama profile and nothing else: a profile *you* typed pointing at `127.0.0.1` is refused until you add the flag
  yourself.
- **A config that already pointed at loopback without the flag will now be refused.** That is the intended default,
  not a regression: the fix is the flag on that entry, not turning the rule off. The refusal carries the reason code
  (`loopback`), the host and a bilingual message, and it surfaces in the run log and in the page you were
  configuring.

## What is measured, and what is not

Measured, in the tests wired into `npm run verify:fast`:

- `tools/config-secrets-test.mjs` — every route that used to leak, the masking rule at depth and in arrays, the
  write-side restore, the `hasXxx` booleans, and the request guard's Host/Origin decisions (its own mutation runs
  are recorded in the commit: disabling redaction fails 14 of its checks, disabling the Host allowlist fails 4).
- `tools/config-durability-test.mjs` — the four load states (including a config damaged while the app runs), the
  atomic write with a process killed between temp and rename, the `.bak`, and the recovery route refusing to
  overwrite.
- `tools/remote-url-test.mjs` — the refusals above, the allowance in both directions (including that
  `allowLoopback` does **not** admit a metadata address), the redirect walk, and the inventory check.

Not measured, and therefore not claimed:

- **No end-to-end browser-through-Tor render has been observed.** The v1.0.4 section of `docs/RELEASE.md` records
  that none had been observed at that release, because Tor was not running on the machine where it was built, and
  it states what *is* proven instead: the SOCKS port is probed before a browser is started, a refusal produces a
  clear reason with no browser launched, and the `proxy` option is honoured by the engine (measured against a
  local SOCKS5 server). Nothing in this tree records a later end-to-end observation, so this document does not
  claim one.
- The URL policy's DNS half is a **decision with a known cost**: a machine behind a proxy whose exit resolves
  names, or a machine that is simply offline, can no longer reach a host its local resolver cannot answer for. That
  cost is paid only on the direct egress, where this machine really is the one resolving.
- No claim is made about what a *remote* site does with the data in the table above. That belongs to the site's own
  policy, and the tools for limiting it are the egress setting (direct / proxy / Tor) and observation mode
  (`docs/OBSERVE.md`).

## Reporting a vulnerability

- **Please report privately.** Open a private security advisory on GitHub:
  `https://github.com/Nesarf/VtuberMonitorLink/security/advisories/new`. If that page is unavailable, open a normal
  issue that says only that you have a security report and asks for a private channel — no details, no
  reproduction, no proof of concept in a public issue.
- **What to include:** the version (`package.json`), the route or module involved, what you did, what you observed,
  and whether a credential may have been exposed. A minimal reproduction against a local checkout is ideal; a
  redacted one is fine. **Do not paste live keys, cookies or BotPasswords into a report** — describe the shape and
  rotate anything that may have leaked *before* you write it down.
- **What is in scope:** the server API and its guard, the config serialization/durability, the URL policy, the
  cookie reader, browser egress and profile handling, the launcher, and the packaging script's exclusion of runtime
  data and secrets. Anything in this repository that changes what leaves the machine, or that lets data from the
  machine leave it unexpectedly, is in scope.
- **What is out of scope:** a machine or user account that is already compromised; the sites this tool fetches from
  and what they do with the requests; third-party services you configure as destinations; and "a local process
  running as my user can call the local API", which is the design described above.
- **No bug bounty.** This is a single-maintainer local tool; reports are handled on a best-effort basis, and credit
  in the release notes is offered unless you prefer otherwise.

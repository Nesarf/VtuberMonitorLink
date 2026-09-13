# Privacy & Publishing Notes / 隐私与发布须知

> This file states Vtuber's Monitor Link's privacy boundaries, and the cleanup that must be done before publishing (committing to a public repository / distributing the .exe).

## Our commitments

1. **No account or cookie is ever packaged or uploaded.**
   Sites that require login (for example X post bodies, Twitch follow lists) are always logged into by the user **in their own browser**;
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

Some sources have to be logged in to scrape (bilibili dynamics with images, X post bodies). This tool offers two routes, and
**by default neither writes cookies to any persistent location**:

### Route A: read-only extraction (recommended; the browser can stay open)

The browser's cookie store is **copied** to a temporary directory and then decrypted: the temporary copy is deleted once used,
and the original profile is neither locked nor modified.

- Only the domains you specify are read (default `bilibili.com`); all other domains are left untouched;
- The decrypted plaintext is assembled into a single Cookie header in this process's memory only, and sent straight to the corresponding site;
- **No log, no report, nothing into `feeds/`**; `POST /api/cookies/check` returns only
  "which cookie names were read", never a value;
- The DPAPI key-decryption step invokes the local `powershell.exe` once (offline, no network);
  on failure it reports an explicit error and does not silently degrade.

Measured: the `v10` scheme of Opera / Chromium 130+ can be decrypted; **when Chrome 127+ has
App-Bound Encryption (`v20`) enabled by default, it cannot be decrypted externally** -- in that case the tool says so
and guides you to route B.

### Route B: Playwright reusing a profile

Point `profileDir` at a logged-in browser and Playwright starts with a persistent context.
**That browser must be fully closed** (otherwise the profile is locked); the cost is higher but it works with every browser.

> If you do not want any tool reading your cookies, do not configure `profileDir`:
> when it is not configured, no extraction is performed, and sources that need login fail honestly with a hint.

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

# Project map

Where things are, what each part owns, and which door an edit comes in through. This is a navigational
document: the reasons live in `DESIGN.md`, the history in `BUGS.md`, and the rules in `ENGLISH-LOGIC.md`.

Measured at the time of writing, from the tree itself: `server/src` holds **50 top-level modules and 45
route modules**; `web/src` holds 56 files; `tools` holds 71 scripts plus 7 in `tools/lib`; `workers`
holds **16 implementations across 13 languages**. `server.js` is 423 lines and registers **no `/api/*`
route of its own** - every one of them lives in `server/src/routes/`.

## Top-level layout

| Path | What it is |
| --- | --- |
| `server/` | The application: `src/` (the whole runtime) and `scripts/` (the sanitize suite: `sanitize-check`, `sanitize-history`, `sanitize-rules`, `smoke`) |
| `web/` | The React front end: `src/` plus `dist/` (a build output) |
| `workers/` | The multilingual worker layer - 13 language directories, `spec/`, and `registry.json` |
| `tools/` | Every gate, traversal and build script; `lib/` holds shared helpers |
| `docs/` | The written record (see below) |
| `launcher/` | How the shipped zip starts: `launch.cmd`, `launch.sh`, `launch.cjs` |
| `feeds/` | **Runtime data**, not source: per-run `_items.json` plus `archive.db` (sqlite) |
| `logs/`, `reports/`, `thumbs/`, `vdb/`, `advice/`, `watch/` | Runtime data, produced by running the app |
| `dist/`, `build/`, `pw-browsers/` | **Build products**: the package, the intermediate build, and the Playwright engine cache (~1 GB) |

An edit belongs in the upper half of that table. The lower half is regenerated or collected, and a change
there is a symptom rather than a fix.

## The server

`server/src/server.js` is the composition root: it builds the Express app, wires configuration, and calls
one registrar per route group. Everything else is a module with one subject.

**Core.** `server.js` (the app factory), `config.js` (load/save/migrate, health, secret handling),
`index.js` (the process entry), `logger.js`, `request-guard.js` (the loopback allowlist for the inbound
HTTP surface), `day.js` (the single definition of "which calendar day does this instant belong to" - see
its `DAY_KEY_CALLERS` inventory).

**Collecting and planning.** `sources.js` (the catalogue), `runner.js` (one run), `scheduler.js`,
`fetchplan.js` (who is due, what fits a budget), `reports.js` (writes the feed files and an item's JSON),
`items.js`, `archive.js` (the sqlite mirror and its aggregates), `cluster.js` (the same event seen from
several sources), `identity.js` / `entities.js` / `people.js` (who is who).

**Network.** `net.js` (egress choice, the global dispatcher, redirect-safe fetching), `socks.js` (the
hand-written SOCKS5 connector used for Tor), `egress.js`, `proxyctl.js` (discovery and diagnosis),
`remote-url.js` (the address policy), `probe.js`.

**Browsers.** `browser-target.js` (which engine, which profile), `browser-consumers.js`, `cookies.js`,
`openfile.js`. The renderer itself is `fetchers/browser.js`.

**Understanding.** `llm.js` (providers, presets, the vision filter), `vision.js`, `analyze.js`,
`features.js` (extraction with a cache), `digest.js`, `diff.js`.

**Judging and telling.** `notify.js` (channels, quiet hours), `silence.js`, `dormant.js`, `groups.js`,
`watch.js` (targets, baselines, change digests), `cost.js`.

**Everything else with a subject.** `search.js` (the local index, its `days` window), `share.js`,
`vdb.js`, `calendar.js`, `privacy.js`, `office.js`, `tar.js`, `thumbs.js`, `docs.js` (the About panel's
fixed document list), `openfile.js`, `diagnose.js`.

**Routes.** `server/src/routes/` holds 45 registrars, each `register<Group>Routes(app, ctx)`. `ctx` is
`getConfig` / `patchConfig` / `log` plus whatever the group explicitly names, and the extras are carried
on both the module signature and the call site - a group that needs `persist` or `busyGuard` says so in
both places. `docs/SERVER-ROUTES.md` is the index; `tools/route-split.cjs` is the extraction tool, and
its rules are boundary conditions rather than advice.

## The front end

`web/src` follows the server's groups: `pages/` mirrors the tabs, `api.js` is the only place a request is
built, `i18n.jsx` plus `locales/` carry 29 locales. `locales/glossary.json` pins proper nouns only; the
translation layers are `overlays.js` (hand-written) and `machine.json` (generated), and a hand layer
always wins.

## The worker layer

`workers/registry.json` is the source of truth: 16 implementations, each declaring its language, the
capabilities it implements, a build argv, the artifact that must exist afterwards, and a launch prefix.
The host appends `--capability <name>`. A missing artifact is reported as a skip, never as a pass.

The capability matrix, as measured:

| Capability | Implementations |
| --- | --- |
| `text.normalize` / `text.extract` / `text.fingerprint` | cpp, csharp, go, java, javascript, perl, pwsh, python, r (9) |
| `search.query` | java, javascript, sql (3) |
| `fetch.plan` | go, javascript (2) |
| `llm.parse` | javascript, python (2) |

The JavaScript implementations are **reference implementations, and are diffed against the others rather
than trusted**. `workers/spec/` holds the cases and the expected output; `docs/WORKERS.md` is the
specification. The point of the layer is differential verification: several languages solving one pure
problem, so a disagreement is visible rather than inferred.

## Documents

`DESIGN.md` (why the parts are shaped this way), `SERVER-ROUTES.md` (the route index), `WORKERS.md` (the
worker specification), `OBSERVE.md` (observation mode and its measurements), `PRIVACY.md`, `VDB.md`,
`RELEASE.md` (version history and the release chain), `PUBLISH.md`, `ENGLISH-LOGIC.md` (the writing rules
and their guards), `BUGS.md` (every defect, with its reproduction and verification).

## How a change is verified

The suite is layered, and running the whole thing for one edit is the wrong trade. Ask which layers the
edit can reach, run those, and leave the full sweep to CI.

| Layer | Command | What it proves |
| --- | --- | --- |
| Static gates | `npm run english-logic`, `node tools/integrity-check.mjs`, `npm run sanitize` | writing rules, structural invariants, no secrets |
| Unit suites | `npm run test:<name>` (about 40 of them) | one subject each, each with controls that must be able to fail |
| Fast gate | `npm run verify:fast` (~51 steps) | all of the above in order; CI runs it on Node 22 and 24 |
| Product | `node tools/traverse-release.cjs` (86), `node tools/traverse-flows.cjs` (40), `node tools/traverse-ui.cjs` (242) | the packaged app really starts and really works - **CI does not run these** |
| Build | `npm run build:release` | the zip layout: `launcher/` plus `runtime/` |

Two rules that keep a green result meaningful: an assertion needs a control that can go red (a mutation
applied to a **temporary copy**, never to the tracked file), and a number in a report is measured rather
than estimated.

## Invariants worth knowing before editing

The English-only rule except for `README.zh-CN.md` and UI strings, guarded by `tools/english-logic.mjs`.
The Node floor of `>=22.19.0`, declared in `package.json` and exercised by a CI leg. A dispatcher is only
ever handed to the `fetch` of its own undici generation, guarded by `integrity-check`. Day keys are
derived only through `day.js`. The shipped artifact is a zip that carries its own runtime - there is no
installer and no SEA binary.

Timing is the application's own: **`scheduler.js` is a built-in scheduler** (daily / merch / watch tasks,
each with a frequency, a time and a catch-up flag, plus a run history) and it needs no OS scheduled task.
It can be switched off, and the startup log says `scheduler disabled` when it is. So "nothing in here
runs on a timer" is not a safe assumption to reason from - an early version of this document made exactly
that mistake from a grep that did not match the way `scheduler.js` arms its timers.


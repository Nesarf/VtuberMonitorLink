# workers/go - the Go workers

Two Go implementations of the multilingual worker layer, built by one module and one build script,
against the contract in `docs/WORKERS.md`:

| artifact | capability | input | output |
| --- | --- | --- | --- |
| `dist/vmltext[.exe]` | `text.normalize` | `{"text": string}` | `{"text": string}` |
| | `text.extract` | `{"html": string, "baseUrl": string\|null}` | `{"title": string, "text": string, "links": [{"href": string, "absolute": boolean, "text": string}], "images": number}` |
| | `text.fingerprint` | `{"text": string}` | `{"simhash": string, "tokens": number, "shingles": number}` |
| `dist/vmlfetch[.exe]` | `fetch.plan` | `{"now": number, "sources": [...], "egress": {...}, "budget": {...}}` | `{"batches": [{"egress": string, "sources": [string]}], "deferred": [{"id": string, "reason": string}], "skipped": [{"id": string, "reason": string}], "counts": {"planned": number, "deferred": number, "skipped": number}}` |

Standard library only. `go.mod` declares no dependency, nothing is downloaded, and nothing touches
the network at build time or run time. The two programs are one module: the text worker is the
package at the module root, the `fetch.plan` planner is the `main` package under `cmd/fetch`. They
share nothing but the module file, which keeps the text worker's package exactly as it was.

## Build

```
node workers/go/build.mjs
```

Run from anywhere; the script resolves its own directory. It prints diagnostics, then runs

```
go build -o workers/go/dist/vmltext[.exe]  .            (go-text)
go build -o workers/go/dist/vmlfetch[.exe] ./cmd/fetch   (go-fetch)
```

with `GOFLAGS=-mod=mod`, `GOPROXY=off` and `CGO_ENABLED=0`, and prints each artifact path as it is
built, so the last stdout line is the last artifact (`workers/go/dist/vmlfetch.exe` on Windows). Both
`workers/registry.json` entries name the same build command; the harness runs it once per run when an
artifact is missing, and a run that finds both artifacts already present builds nothing. If `go` is
missing the script fails with an English message and exit 1; `go` is looked for on `PATH`, then under
`$env:GO_ROOT\bin` / `$env:GOROOT\bin`. Nothing in this directory knows where Go is installed on any
particular machine, on purpose: a path from one developer's disk is not a build script.

Built and tested with `go version go1.27.1 windows/amd64`; `go.mod` asks for `go 1.21`, so an older
toolchain (including the one on a CI runner) can build it too.

## Run

```
workers/go/dist/vmltext.exe  --capability text.normalize   # the host's launch form
workers/go/dist/vmltext.exe  --selfcheck                  # 33 built-in cases, one English line each
workers/go/dist/vmlfetch.exe --capability fetch.plan
workers/go/dist/vmlfetch.exe --selfcheck                  # 28 built-in cases, one English line each
```

The workers speak JSON Lines over stdio: one JSON object per line, UTF-8, LF, no BOM. stdout carries
protocol lines and nothing else; every diagnostic is English text on stderr. Unknown arguments, a
missing `--capability`, and an unknown capability name exit 2 with an English message on stderr.
`--selfcheck` writes no protocol traffic (for `vmlfetch` its checks are its whole stdout, which is why
running the two artifacts' self-checks in one command shows two interleaved summaries).

### Where the shared tables come from - the choice this README has to state

**The tables are loaded at run time, not embedded.** `vmlfetch` does not read them at all: `fetch.plan`
has no case or fold table, and the planner's own `--selfcheck` therefore runs without
`workers/spec/` being present. `vmltext` is the artifact that needs them.

`workers/spec/latin-lower.json` and `workers/spec/latin-fold.json` are read from disk on startup, so a
regenerated table is picked up by restarting the worker rather than by rebuilding it, and `git diff` on
the spec files shows the difference that matters. `go:embed` was the alternative and is still a
one-commit change (`//go:embed` plus `embed.FS` in `spec_tables.go`) if embedding is ever preferred.

Resolution order (`searchRepoSpec`): `<exe dir>/spec`, then `<exe dir>/../../spec` (which is
`workers/spec` for the contract's `workers/go/dist/vmltext.exe`), then every ancestor of the working
directory looking for `workers/spec`. That covers both the host's launch form and a direct run from
the repository root. A missing table is a hard failure: exit 2 with an English message, never a
silent fallback to the runtime's own Unicode tables.

## Strategy: `vmltext` (`text.*`)

- **`normalize.go`** - the six contract steps in order, over code points. Step 1 deletes the listed
  ranges (controls, zero-width and bidi controls, BOM, combining marks). Step 2 maps one-to-many for
  U+2026 only. Steps 3 and 4 apply the two shared tables **in sequence**: a code point the lower
  table maps (E-acute -> e-acute) is still folded afterwards (e-acute -> e).
  `unicode.ToLower`, `strings.ToLower` and `golang.org/x/text` are **not used**: the tables are the
  rule, not the runtime's tables. (`strings.ToLower` does appear once, in `extract.go`, but only on
  ASCII tag names, where it is the case-insensitive tag match the extract contract asks for.)
- **`extract.go`** - the specified state machine, not an HTML parser: comments and doctypes are
  removed, the six removed elements go with their content (a missing closing tag runs to end of
  input), then one walk over the survivors handles tag names, block-tag newlines, title collection,
  `<a>` links, `<img` counting and entity decoding. Three rules that the corpus had to pin:
  - **Nested anchors follow the browser**: an `<a>` opened while another is open closes and reports
    the outer one, so both hrefs survive. (This worker flagged the original "ignore the inner anchor"
    rule, which silently dropped a link; the contract was changed to the browser behaviour.)
  - **CDATA is character data, and removal wins over it.** `liftCDATA` is the *first* pass: it takes
    every `<![CDATA[...]]>` body out of the document into a side table and leaves a U+0001 placeholder
    behind, so nothing inside the body is re-parsed as markup (`<b>` survives as text, entities stay
    inert) and the walk restores the bodies in order. Because the lift happens before the
    removed-element pass, a `<script>` **inside** a CDATA section is text and survives, while a CDATA
    section **inside** a real removed element is removed with it. An unclosed CDATA keeps everything
    to end of input.
  - **A title belongs to the title and to nothing else** - not to the body, not to an anchor's text -
    and **a tag that is never closed before end of input contributes nothing at all**, not even the
    newline a block tag would give (`<p` at EOF is the empty string).
- **`fingerprint.go`** - split on single spaces, strip leading/trailing ASCII punctuation from each
  token, group the rest into CJK runs (bigrams for runs of 2+) and "other" runs, shingle in runs of
  3, hash with FNV-1a 64 in `uint64` (wraparound is the type's own behaviour), and fold the hashes
  into 64 counters. Manual hex, no formatting library.
- **`protocol.go`** - every response is written as an explicit byte sequence. The contract makes key
  order part of the diffed output, and JSON emits map keys in a random order, so **no map reaches the
  output**: tables are walked as fixed slices, an `entityNameOrder` slice fixes the entity search
  order, and the sorted key list in `spec_tables.go` exists only so a duplicate-key diagnostic is
  stable. Strings go through `encoding/json`'s string encoder with `SetEscapeHTML(false)` so escaping
  matches `JSON.stringify` (raw `<`, `>`, `&`, raw U+2028/U+2029, raw UTF-8), while the delimiters and
  field order are written by hand. The field orders are documented at the top of `protocol.go`.
- **`selfcheck.go`** - 33 cases with literal expectations, covering every rule the contract calls out
  as tricky: unclosed tag at EOF, an unclosed tag exactly at EOF, a lone `<` at EOF, a tag name alone
  at EOF, unclosed removed element, CDATA with markup inside it, an unclosed CDATA, inert entities
  inside CDATA, removal winning over CDATA and the reverse, a title inside an anchor, entity with and
  without a semicolon, numeric and hex references, an unknown entity, no
  backtracking (`&copy2024`, `&ampersand`), zero-width characters, combining marks (NFD == NFC),
  full-width ASCII, CJK/Cyrillic passthrough, U+0130, two idempotency pairs, empty input, nested
  anchors and an unclosed anchor, and edge-punctuation trimming in the fingerprint. Three of them
  compare two runs of the worker against each other (idempotency, punctuation-invariance, NFC/NFD
  equality) instead of against a literal.

## Strategy: `vmlfetch` (`fetch.plan`)

- **`cmd/fetch/plan.go`** - the six rules of `docs/WORKERS.md` section 10 in the order the contract
  applies them: egress existence first (`no-egress`, checked before the clock, so a broken egress name
  is never reported as a source that is merely early), then due-ness (`interval`), then the order
  inside a batch, then one batch per egress, then the budget (`budget`), then counts and list order.
  The planner is pure: it reads no clock, has no randomness, and every list it emits has a specified
  order.
  - **`lastRunAt` is kept as an exact integer and compared with the clock**, never tested for truth:
    `0` is the epoch, and `!lastRunAt` is the bug the rule exists to prevent. A *missing* `lastRunAt`
    and a `null` one both mean "never run", which is the other half of the same distinction - the two
    cases are the values `nil` (never run) and a real `*exactInt` (a timestamp), so no default value
    can be confused with a timestamp.
  - **Ordering is UTF-8 bytes**, which in Go is the language's own string comparison: `sort.Strings`,
    not `strings.Collate` (a collation puts `e-acute` between `a` and `b`), and not a byte-by-byte
    walk that would be slow rather than wrong. `z` before `e-acute` and U+FFFD before an astral
    character are both pinned in `selfcheck.go`.
  - **No map iteration order reaches the output.** Egress names are collected into a slice and sorted
    before anything is emitted; that decides the batch order, the order a shared budget is spent in,
    and the order the deferred list is appended in. The `budget.maxPerEgress` map is only ever read
    through a sorted key list - including when an error message names a bad entry, because an error
    message that changes with the map order is a flaky test. One self-check runs a plan 200 times and
    compares the bytes.
- **`cmd/fetch/numbers.go`** - `now`, `lastRunAt` and `minIntervalMs` are read as `big.Rat` values
  that are always whole numbers. Three traps, all avoided: a float64 (what `encoding/json` hands back
  for a bare `interface{}`) cannot hold every epoch millisecond exactly; `int64` subtraction wraps, so
  `now = MaxInt64` with a negative `lastRunAt` would report a due source as too early; and a value
  written `500.0` or `1e2` **is** an integer while `1.5` is not, which is a distinction a
  string-matching check would get wrong. `big.Rat` parses all three JSON number forms exactly, without
  a float anywhere. Limits are clamped to the `int` range before they meet a comparison, so a
  `budget.maxRequests` of `1e30` behaves as "no limit" instead of wrapping negative.
- **`cmd/fetch/jsonwire.go`** - the protocol, a deliberate copy of the text worker's `protocol.go`:
  Go has no way to share those helpers between two `main` packages without an internal package, and
  the same explicit byte-order encoder is needed here. Every response (describe, invoke output, error,
  shutdown) and the output object itself are written key by key in the contract's order.
- **`cmd/fetch/selfcheck.go`** - 28 cases with literal expectations: the whole answer with its key
  order, `lastRunAt: 0` twice (not due, then due at the inclusive boundary), an unknown egress skipped
  while not due, a missing `egress` object, byte order for egress names and for ids, the shared budget
  spent in egress-name order, a budget of zero, `maxPerEgress` before `maxConcurrent`, no empty
  batches, both report lists sorted, 200 identical runs compared byte for byte, and eleven `bad-input`
  shapes.

## Verification performed

- `node workers/go/build.mjs`: both artifacts built, exit 0.
- `gofmt -l .` on `workers/go`: no output; `go vet ./...`: exit 0.
- `vmltext --selfcheck`: 33/33, exit 0. `vmlfetch --selfcheck`: 28/28, exit 0.
- `node tools/workers.mjs --no-build --published-only`: this worker is in the **unanimous group on
  every corpus case** (31 extract, 16 fingerprint, 20 normalize) together with `js-text`, `java-text`,
  `cpp-text` and `python-text`; no case has this worker in a group of its own.
- `npm run workers -- --cap fetch.plan`: 25/25 unanimous across `js-fetch` and `go-fetch`, no `note`
  line, and the snapshot in `workers/spec/expected/fetch.plan.json` is matched.
- A differential run put 344 `fetch.plan` inputs (300 generated, 44 hand-written to reach the
  branches the generator cannot, including protocol-level shapes: a non-object source, a non-array
  `sources`, `due` as a string, `lastRunAt` as `true`, `maxConcurrent` as `2.5`, `1e3`, `500.0`, the
  maximum int64 and `-9223372036854775808`) through this worker and through `workers/js/vmlfetch.js`
  over the real stdio protocol and the harness's own canonicalisation: **343 of 344 identical**, and
  the one difference is written down below (it is a `bad-input` shape the reference treats as a skip,
  and no corpus case sends it). The run is reproducible - it is `node workers/go/differential-fetch.mjs`,
  which reuses the conformance runner's own worker-runner rather than reimplementing the protocol - and
  a second seed gives the same single difference.
- A private differential run put 80 capability invocations (30 normalize, 32 extract, 20 fingerprint)
  through `vmltext` and through `workers/js/vmltext.js` over the real stdio protocol: every
  capability line was byte-identical. The only differing lines were `describe` (each implementation
  names its own language and runtime, so it can never be byte-identical by construction) and
  `shutdown` (see the deviation below).

## Known limits and deliberate choices

1. **`fetch.plan`: an `egress` that is not a string is `bad-input`, not a `no-egress` skip.** The
   contract's `egress` member is a string ("Anything outside those shapes is `bad-input`"), and a
   number there is a malformed request rather than a source pointing at an egress that does not exist.
   `workers/js/vmlfetch.js` answers `skipped`/`no-egress` for it instead, because its lookup simply
   fails to find the key. This is the only divergence the 344-case differential run found, no corpus
   case covers it (all 25 send strings), and the self-check pins this worker's answer. Reported, not
   hidden: it is a hole in section 10 rather than a bug in either implementation.
2. **`fetch.plan`: a source that is not an object is `bad-input`.** The reference reaches
   `source?.id` on a string or a number and throws `bad-input` for the missing id, so the two agree on
   the code; the message differs by design.
3. **Invalid UTF-8 input** is replaced with U+FFFD (`strings.ToValidUTF8`) before normalization. The
   transport is UTF-8 bytes and a code point is what the steps operate on; the contract does not say
   what an invalid byte is, and this is the one behaviour that differs from the JavaScript reference,
   which decodes with `TextDecoder`-style replacement at read time.
4. **Numeric references decode to their own code point**, including `&#0;` -> U+0000 and `&#160;` ->
   U+00A0. Those values are then mapped or deleted by the normalizer, not by the extractor
   (contract section 3 step 7), and in the JSON output NUL and U+00A0 appear as `\u0000` and a raw
   two-byte sequence respectively, exactly as `JSON.stringify` writes them.
5. **`baseUrl` is validated as string-or-null and otherwise ignored.** Contract section 3 step 4 keeps
   hrefs verbatim and puts URL resolution outside a text function.
6. **A `>` inside an unquoted attribute value ends the tag** (e.g. `<a href=x>y>`). The contract only
   protects `>` inside quoted values, and treating an unquoted `>` as an error would diverge from
   every other implementation.
7. **`--capability` given twice** takes the last value instead of being rejected as an unknown
   argument; everything else on the command line is an error with exit 2.
8. **Spec tables are read at run time**, so `vmltext` is not self-contained: it needs `workers/spec/`
   reachable from its own directory or from an ancestor of the working directory (see above).
   `vmlfetch` needs no spec file at all.
9. **`shutdown` answers the bare envelope** `{"id":<id>,"ok":true}`, which is what the contract's
   response block shows. The JavaScript reference and `workers/java` carried an extra
   `"output":{"bye":true}` payload; the contract now says the bare form explicitly, and states that
   the reference is not the contract, so this worker was already right and the others were wrong.
   Nothing diffs a shutdown line, which is why the split survived four implementations.
10. **`describe` field order** follows the contract's example order (`protocol`, `capability`,
    `language`, `impl`, `runtime`, `deterministic`). A descriptor can never be byte-identical across
    implementations - `language`, `impl` and `runtime` differ by definition - so it is deliberately not
    diffed; only `invoke` output is.

## Files

| file | contents |
| --- | --- |
| `main.go` | `vmltext`: command line, capability dispatch, the stdio request loop |
| `protocol.go` | `vmltext`: response envelopes and output encoders, key order included |
| `normalize.go` | `text.normalize` |
| `extract.go` | `text.extract` (tag state machine, entities) |
| `fingerprint.go` | `text.fingerprint` (tokenizer, FNV-1a, SimHash) |
| `spec_tables.go` | loading and validating the shared tables, spec directory search |
| `selfcheck.go` | `vmltext`'s `--selfcheck` case list |
| `cmd/fetch/main.go` | `vmlfetch`: command line, capability dispatch, the stdio request loop |
| `cmd/fetch/jsonwire.go` | `vmlfetch`: the protocol and the output encoder |
| `cmd/fetch/plan.go` | `fetch.plan` (the six rules in contract order) |
| `cmd/fetch/numbers.go` | exact integer arithmetic for `now`, `lastRunAt`, `minIntervalMs` and the limits |
| `cmd/fetch/selfcheck.go` | `vmlfetch`'s `--selfcheck` case list |
| `differential-fetch.mjs` | development-only: 344 generated and hand-written `fetch.plan` inputs through both implementations |
| `build.mjs` | portable Node build script, both artifacts |
| `go.mod` | module `vmltext`, no dependencies, two `main` packages |
| `dist/vmltext.exe`, `dist/vmlfetch.exe` | the artifacts the host launches |

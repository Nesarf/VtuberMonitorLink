# workers/go — the Go text worker

A Go implementation of the three text capabilities of the multilingual worker layer, against the
contract in `docs/WORKERS.md` sections 1-4:

| capability | input | output |
| --- | --- | --- |
| `text.normalize` | `{"text": string}` | `{"text": string}` |
| `text.extract` | `{"html": string, "baseUrl": string\|null}` | `{"title": string, "text": string, "links": [{"href": string, "absolute": boolean, "text": string}], "images": number}` |
| `text.fingerprint` | `{"text": string}` | `{"simhash": string, "tokens": number, "shingles": number}` |

Standard library only. `go.mod` declares no dependency, nothing is downloaded, and nothing touches
the network at build time or run time.

## Build

```
node workers/go/build.mjs
```

Run from anywhere; the script resolves its own directory. It prints diagnostics, runs
`go build -o workers/go/dist/vmltext.exe .` with `GOFLAGS=-mod=mod`, `GOPROXY=off` and
`CGO_ENABLED=0`, and prints the artifact path (`workers/go/dist/vmltext.exe`) as the **last** stdout
line, which is what the host reads. If `go` is missing it fails with an English message and exit 1;
`go` is looked for on `PATH`, then under `$env:GO_ROOT\bin` / `$env:GOROOT\bin`. Nothing in this
directory knows where Go is installed on any particular machine, on purpose: a path from one
developer's disk is not a build script.

Built and tested with `go version go1.27.1 windows/amd64`; `go.mod` asks for `go 1.21`, so an older
toolchain (including the one on a CI runner) can build it too.

## Run

```
workers/go/dist/vmltext.exe --capability text.normalize     # the host's launch form
workers/go/dist/vmltext.exe --selfcheck                     # 24 built-in cases, one English line each
```

The worker speaks JSON Lines over stdio: one JSON object per line, UTF-8, LF, no BOM. stdout carries
protocol lines and nothing else; every diagnostic is English text on stderr. Unknown arguments, a
missing `--capability`, and an unknown capability name exit 2 with an English message on stderr.
`--selfcheck` writes no protocol traffic.

### Where the shared tables come from — the choice this README has to state

**The tables are loaded at run time, not embedded.** `workers/spec/latin-lower.json` and
`workers/spec/latin-fold.json` are read from disk on startup, so a regenerated table is picked up by
restarting the worker rather than by rebuilding it, and `git diff` on the spec files shows the
difference that matters. `go:embed` was the alternative and is still a one-commit change
(`//go:embed` plus `embed.FS` in `spec_tables.go`) if embedding is ever preferred.

Resolution order (`searchRepoSpec`): `<exe dir>/spec`, then `<exe dir>/../../spec` (which is
`workers/spec` for the contract's `workers/go/dist/vmltext.exe`), then every ancestor of the working
directory looking for `workers/spec`. That covers both the host's launch form and a direct run from
the repository root. A missing table is a hard failure: exit 2 with an English message, never a
silent fallback to the runtime's own Unicode tables.

## Strategy

- **`normalize.go`** — the six contract steps in order, over code points. Step 1 deletes the listed
  ranges (controls, zero-width and bidi controls, BOM, combining marks). Step 2 maps one-to-many for
  U+2026 only. Steps 3 and 4 apply the two shared tables **in sequence**: a code point the lower
  table maps (E-acute -> e-acute) is still folded afterwards (e-acute -> e). Steps 5 and 6 are one
  pass that collapses space/tab/LF/CR runs and emits no leading or trailing space.
  `unicode.ToLower`, `strings.ToLower` and `golang.org/x/text` are **not used**: the tables are the
  rule, not the runtime's tables. (`strings.ToLower` does appear once, in `extract.go`, but only on
  ASCII tag names, where it is the case-insensitive tag match the extract contract asks for.)
- **`extract.go`** — the specified state machine, not an HTML parser: comments and doctypes are
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
  - **A title belongs to the title and to nothing else** — not to the body, not to an anchor's text —
    and **a tag that is never closed before end of input contributes nothing at all**, not even the
    newline a block tag would give (`<p` at EOF is the empty string).
- **`fingerprint.go`** — split on single spaces, strip leading/trailing ASCII punctuation from each
  token, group the rest into CJK runs (bigrams for runs of 2+) and "other" runs, shingle in runs of
  3, hash with FNV-1a 64 in `uint64` (wraparound is the type's own behaviour), and fold the hashes
  into 64 counters. Manual hex, no formatting library.
- **`protocol.go`** — every response is written as an explicit byte sequence. The contract makes key
  order part of the diffed output, and JSON emits map keys in a random order, so **no map reaches the
  output**: tables are walked as fixed slices, an `entityNameOrder` slice fixes the entity search
  order, and the sorted key list in `spec_tables.go` exists only so a duplicate-key diagnostic is
  stable. Strings go through `encoding/json`'s string encoder with `SetEscapeHTML(false)` so escaping
  matches `JSON.stringify` (raw `<`, `>`, `&`, raw U+2028/U+2029, raw UTF-8), while the delimiters and
  field order are written by hand. The field orders are documented at the top of `protocol.go`.
- **`selfcheck.go`** — 33 cases with literal expectations, covering every rule the contract calls out
  as tricky: unclosed tag at EOF, an unclosed tag exactly at EOF, a lone `<` at EOF, a tag name alone
  at EOF, unclosed removed element, CDATA with markup inside it, an unclosed CDATA, inert entities
  inside CDATA, removal winning over CDATA and the reverse, a title inside an anchor, entity with and
  without a semicolon, numeric and hex references, an unknown entity, no
  backtracking (`&copy2024`, `&ampersand`), zero-width characters, combining marks (NFD == NFC),
  full-width ASCII, CJK/Cyrillic passthrough, U+0130, two idempotency pairs, empty input, nested
  anchors and an unclosed anchor, and edge-punctuation trimming in the fingerprint. Three of them
  compare two runs of the worker against each other (idempotency, punctuation-invariance, NFC/NFD
  equality) instead of against a literal.

## Verification performed

- `node workers/go/build.mjs` clean build, `--selfcheck` 33/33, exit 0.
- `node tools/workers.mjs --no-build --published-only`: this worker is in the **unanimous group on
  every corpus case** (31 extract, 16 fingerprint, 20 normalize) together with `js-text`, `java-text`,
  `cpp-text` and `python-text`; no case has this worker in a group of its own.
- A private differential run put 80 capability invocations (30 normalize, 32 extract, 20 fingerprint)
  through this worker and through `workers/js/vmltext.js` over the real stdio protocol: every
  capability line was byte-identical. The only differing lines were `describe` (each implementation
  names its own language and runtime, so it can never be byte-identical by construction) and
  `shutdown` (see the deviation below).

## Known limits and deliberate choices

1. **Invalid UTF-8 input** is replaced with U+FFFD (`strings.ToValidUTF8`) before normalization. The
   transport is UTF-8 bytes and a code point is what the steps operate on; the contract does not say
   what an invalid byte is, and this is the one behaviour that differs from the JavaScript reference,
   which decodes with `TextDecoder`-style replacement at read time.
2. **Numeric references decode to their own code point**, including `&#0;` -> U+0000 and `&#160;` ->
   U+00A0. Those values are then mapped or deleted by the normalizer, not by the extractor
   (contract section 3 step 7), and in the JSON output NUL and U+00A0 appear as `\u0000` and a raw
   two-byte sequence respectively, exactly as `JSON.stringify` writes them.
3. **`baseUrl` is validated as string-or-null and otherwise ignored.** Contract section 3 step 4 keeps
   hrefs verbatim and puts URL resolution outside a text function.
4. **A `>` inside an unquoted attribute value ends the tag** (e.g. `<a href=x>y>`). The contract only
   protects `>` inside quoted values, and treating an unquoted `>` as an error would diverge from
   every other implementation.
5. **`--capability` given twice** takes the last value instead of being rejected as an unknown
   argument; everything else on the command line is an error with exit 2.
6. **Spec tables are read at run time**, so the artifact is not self-contained: it needs
   `workers/spec/` reachable from its own directory or from an ancestor of the working directory (see
   above).
7. **`shutdown` answers the bare envelope** `{"id":<id>,"ok":true}`, which is what the contract's
   response block shows. The JavaScript reference and `workers/java` carried an extra
   `"output":{"bye":true}` payload; the contract now says the bare form explicitly, and states that
   the reference is not the contract, so this worker was already right and the others were wrong.
   Nothing diffs a shutdown line, which is why the split survived four implementations.
8. **`describe` field order** follows the contract's example order (`protocol`, `capability`,
   `language`, `impl`, `runtime`, `deterministic`). A descriptor can never be byte-identical across
   implementations — `language`, `impl` and `runtime` differ by definition — so it is deliberately not
   diffed; only `invoke` output is.

## Files

| file | contents |
| --- | --- |
| `main.go` | command line, capability dispatch, the stdio request loop |
| `protocol.go` | response envelopes and output encoders, key order included |
| `normalize.go` | `text.normalize` |
| `extract.go` | `text.extract` (tag state machine, entities) |
| `fingerprint.go` | `text.fingerprint` (tokenizer, FNV-1a, SimHash) |
| `spec_tables.go` | loading and validating the shared tables, spec directory search |
| `selfcheck.go` | the `--selfcheck` case list |
| `build.mjs` | portable Node build script |
| `go.mod` | module `vmltext`, no dependencies |
| `dist/vmltext.exe` | the artifact the host launches |
